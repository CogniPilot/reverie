//! Existing configured HTTP(S) llama embeddings and startup probe fallback.
//! The lexical backend remains the original algorithm; response data grants no
//! model, owner, execution or persistence authority.
mod http;
mod idna;
mod policy;
mod redirect;
#[cfg(test)]
mod tests;
mod timed_io;
use policy::ProxySettings;
use reverie_contracts::memory::{
    EmbeddingContractError, EmbeddingResponse, embedding_model_name, embedding_text,
    encode_embedding_request_text,
};
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::memory::{
    Embedder, EmbeddingError, EmbeddingKind, EmbeddingText, HashedEmbedder, normalize,
};
use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
#[derive(Clone, Debug)]
pub struct LlamaConfig {
    pub url: MetadataText,
    pub model: MetadataText,
    pub timeout: Duration,
    pub document_prefix: MetadataText,
    pub query_prefix: MetadataText,
}
impl LlamaConfig {
    pub fn new(url: impl Into<String>, model: impl Into<String>) -> Self {
        Self::from_text(
            MetadataText::from_scalar_text(&url.into()),
            MetadataText::from_scalar_text(&model.into()),
        )
    }
    pub fn from_text(url: MetadataText, model: MetadataText) -> Self {
        Self {
            url,
            model,
            timeout: Duration::from_secs(60),
            document_prefix: MetadataText::from_scalar_text("search_document: "),
            query_prefix: MetadataText::from_scalar_text("search_query: "),
        }
    }
}
#[derive(Debug)]
pub enum LlamaError {
    InvalidEndpoint,
    UnsupportedTransport,
    Redirect,
    HttpStatus(u16),
    Transport(Box<dyn std::error::Error + Send + Sync>),
    Contract(EmbeddingContractError),
    Worker,
}
impl fmt::Display for LlamaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HttpStatus(code) => write!(f, "embedding HTTP status {code}"),
            Self::Contract(_) => write!(f, "embedding response refused"),
            Self::Transport(_) => write!(f, "embedding transport failed"),
            _ => write!(f, "embedding request refused"),
        }
    }
}
impl std::error::Error for LlamaError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport(error) => Some(error.as_ref()),
            Self::Contract(error) => Some(error),
            _ => None,
        }
    }
}
pub(super) type Result<T> = std::result::Result<T, LlamaError>;
pub(super) fn transport(error: impl std::error::Error + Send + Sync + 'static) -> LlamaError {
    LlamaError::Transport(Box::new(error))
}
pub struct LlamaEmbedder {
    config: LlamaConfig,
    name: MetadataText,
    dimensions: AtomicUsize,
    proxies: ProxySettings,
}
impl LlamaEmbedder {
    pub fn new(mut config: LlamaConfig) -> Self {
        let end = config
            .url
            .codepoints()
            .iter()
            .rposition(|&cp| cp != 47)
            .map_or(0, |index| index + 1);
        config.url =
            MetadataText::from_python_text(config.url.as_python_text_ref().take(end).into_owned());
        let name = embedding_model_name(&config.model);
        Self {
            config,
            name,
            dimensions: AtomicUsize::new(0),
            proxies: ProxySettings::capture(),
        }
    }
    pub fn request_embedding(&self, text: &str, kind: EmbeddingKind) -> Result<Vec<f64>> {
        self.request_embedding_text(EmbeddingText::from_scalar_text(text), kind)
    }
    pub fn request_embedding_text(
        &self,
        text: EmbeddingText<'_>,
        kind: EmbeddingKind,
    ) -> Result<Vec<f64>> {
        let prefix = match kind {
            EmbeddingKind::Query => &self.config.query_prefix,
            EmbeddingKind::Document => &self.config.document_prefix,
        };
        let mut input = prefix.codepoints().to_vec();
        input.extend_from_slice(&text.codepoints());
        let input = embedding_text(
            EmbeddingText::from_codepoints(&input).expect("valid prefix and embedding text"),
        );
        let body = encode_embedding_request_text(&input, &self.config.model);
        self.request_body(body)
    }
    fn request_body(&self, body: Vec<u8>) -> Result<Vec<f64>> {
        let mut url = self.config.url.codepoints().to_vec();
        url.extend("/embeddings".chars().map(u32::from));
        let url = MetadataText::from_python_text(
            reverie_core::PythonText::try_new(url).expect("checked URL and ASCII suffix"),
        );
        // A private runtime thread also supports callers already running a
        // Tokio executor. Joining retains ordinary synchronous Embedder behavior.
        let raw = std::thread::scope(|scope| {
            let worker = std::thread::Builder::new()
                .name("reverie-embedding-http".into())
                .spawn_scoped(scope, || {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(transport)?;
                    runtime.block_on(http::request(url, body, self.config.timeout, &self.proxies))
                })
                .map_err(transport)?;
            worker.join().map_err(|_| LlamaError::Worker)?
        })?;
        let response = EmbeddingResponse::decode(&raw).map_err(LlamaError::Contract)?;
        self.dimensions
            .store(response.dimensions(), Ordering::Relaxed);
        let vector = response.vector().map_err(LlamaError::Contract)?;
        Ok(normalize(&vector))
    }
}
impl Embedder for LlamaEmbedder {
    fn name(&self) -> EmbeddingText<'_> {
        EmbeddingText::from_python_text_ref(self.name.as_python_text_ref())
    }
    fn dimensions(&self) -> usize {
        self.dimensions.load(Ordering::Relaxed)
    }
    fn embed_text(
        &self,
        text: EmbeddingText<'_>,
        kind: EmbeddingKind,
    ) -> std::result::Result<Vec<f64>, EmbeddingError> {
        self.request_embedding_text(text, kind)
            .map_err(|error| EmbeddingError::Backend(error.to_string()))
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EmbeddingFallback {
    ProbeFailed,
}
pub struct EmbeddingSelection {
    pub embedder: Arc<dyn Embedder>,
    pub fallback: Option<EmbeddingFallback>,
}
/// Exactly one startup probe selects the configured model or lexical fallback.
/// Later requests never silently fall back or substitute vector/model identity.
pub fn make_embedder(config: Option<LlamaConfig>, dimensions: usize) -> EmbeddingSelection {
    if let Some(config) = config.filter(|config| !config.url.codepoints().is_empty()) {
        let embedder = LlamaEmbedder::new(config);
        if embedder
            .request_embedding("probe", EmbeddingKind::Document)
            .is_ok()
        {
            return EmbeddingSelection {
                embedder: Arc::new(embedder),
                fallback: None,
            };
        }
        return EmbeddingSelection {
            embedder: Arc::new(HashedEmbedder::new(dimensions)),
            fallback: Some(EmbeddingFallback::ProbeFailed),
        };
    }
    EmbeddingSelection {
        embedder: Arc::new(HashedEmbedder::new(dimensions)),
        fallback: None,
    }
}
