//! Embedding stream for the remaining legacy memory store. The child owns
//! backend selection and vectors and receives no database path.
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::{
    PythonText,
    memory::{Embedder, EmbeddingKind, EmbeddingText},
    memory_configuration::ConfigInteger,
};
use reverie_host::embeddings::{LlamaConfig, make_configured_embedder};
use serde::Deserialize;
use std::io::{self, BufWriter, Write};

#[derive(Deserialize)]
struct Initialization {
    dimensions: String,
    endpoint: Option<Endpoint>,
}

#[derive(Deserialize)]
struct Endpoint {
    url: Vec<u32>,
    model: Vec<u32>,
    document_prefix: Vec<u32>,
    query_prefix: Vec<u32>,
}

impl Endpoint {
    fn configure(self) -> io::Result<LlamaConfig> {
        let mut config = LlamaConfig::from_text(text(self.url)?, text(self.model)?);
        config.document_prefix = text(self.document_prefix)?;
        config.query_prefix = text(self.query_prefix)?;
        Ok(config)
    }
}

fn text(points: Vec<u32>) -> io::Result<MetadataText> {
    PythonText::try_new(points)
        .map(MetadataText::from_python_text)
        .map_err(io::Error::other)
}

#[derive(Deserialize)]
struct Request {
    text: Vec<u32>,
    query: bool,
}

impl Request {
    fn run(&self, embedder: &dyn Embedder, output: &mut impl Write) -> io::Result<()> {
        let kind = if self.query {
            EmbeddingKind::Query
        } else {
            EmbeddingKind::Document
        };
        let vector = EmbeddingText::from_codepoints(&self.text)
            .and_then(|text| embedder.embed_text(text, kind));
        // Fixed-width values retain the existing f64 results, including
        // signed zero and any non-finite values returned by the backend.
        match vector {
            Ok(vector) => {
                output.write_all(&(vector.len() as u64).to_le_bytes())?;
                for value in vector {
                    output.write_all(&value.to_le_bytes())?;
                }
            }
            Err(_) => output.write_all(&u64::MAX.to_le_bytes())?,
        }
        output.flush()
    }
}

pub(crate) fn run(expected_parent: i32) -> io::Result<()> {
    // The pipe tracks the whole caller process even when the thread that
    // launched this shared worker exits.
    crate::check_worker_parent(expected_parent)?;
    let initial: Initialization = serde_json::Deserializer::from_reader(io::stdin().lock())
        .into_iter()
        .next()
        .ok_or_else(crate::refused)??;
    let dimensions = ConfigInteger::parse(&PythonText::from_scalar_text(&initial.dimensions))
        .ok_or_else(crate::refused)?;
    let backend = make_configured_embedder(
        initial.endpoint.map(Endpoint::configure).transpose()?,
        &dimensions,
    );
    let backend = backend.embedder.as_ref();
    let mut output = BufWriter::new(io::stdout().lock());
    let name = backend.name();
    serde_json::to_writer(&mut output, &(name.codepoints(), backend.dimensions()))?;
    output.write_all(b"\n")?;
    output.flush()?;

    for request in serde_json::Deserializer::from_reader(io::stdin().lock()).into_iter::<Request>()
    {
        request?.run(backend, &mut output)?;
    }
    Ok(())
}
