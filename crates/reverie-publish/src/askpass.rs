//! This binary doubles as git's `GIT_ASKPASS` for a push: git runs it with the prompt as its only
//! argument, and it answers from the token file named in its environment. git reads the answer
//! from a pipe, so the token is never in an argument list or a shell.

/// Set to `1` when this binary is running as askpass.
pub const MODE: &str = "REVERIE_PUBLISH_ASKPASS";
/// The path of the file holding the token.
pub const TOKEN_FILE: &str = "REVERIE_PUBLISH_TOKEN_FILE";

/// The answer to one git credential prompt: the token as the password, and GitHub's fixed user
/// name for token authentication as the user name. Any other prompt is refused.
pub fn answer(prompt: &str, token: &str) -> Result<String, String> {
    let token = token.trim();
    if token.is_empty() || token.contains(char::is_whitespace) {
        return Err("the token file must hold one token".into());
    }
    if prompt.starts_with("Username") {
        Ok("x-access-token".into())
    } else if prompt.starts_with("Password") {
        Ok(token.to_owned())
    } else {
        Err("not a git credential prompt".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_only_the_two_credential_prompts() {
        assert_eq!(
            answer("Username for 'https://github.com': ", "tok\n").unwrap(),
            "x-access-token"
        );
        assert_eq!(
            answer(
                "Password for 'https://x-access-token@github.com': ",
                "tok\n"
            )
            .unwrap(),
            "tok"
        );
        assert!(answer("Are you sure you want to continue? ", "tok").is_err());
        assert!(answer("Password: ", "two words").is_err());
    }
}
