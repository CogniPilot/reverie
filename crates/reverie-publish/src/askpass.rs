//! This binary doubles as git's `GIT_ASKPASS` for a push: git runs it with the prompt as its only
//! argument, and it answers from the token file named in its environment. git reads the answer
//! from a pipe, so the token is never in an argument list or a shell.

/// Set to `1` when this binary is running as askpass.
pub const MODE: &str = "REVERIE_PUBLISH_ASKPASS";
/// The path of the file holding the token.
pub const TOKEN_FILE: &str = "REVERIE_PUBLISH_TOKEN_FILE";

/// git's user-name prompt for GitHub over HTTPS, the only origin a token is ever given to.
const USERNAME_PROMPT: &str = "Username for 'https://github.com': ";
/// git's password prompt once GitHub's token user name has been given for that origin.
const PASSWORD_PROMPT: &str = "Password for 'https://x-access-token@github.com': ";

/// The token file's one token, or why it is not one.
pub fn token(contents: &str) -> Result<&str, String> {
    let token = contents.trim();
    if token.is_empty() || token.contains(char::is_whitespace) {
        return Err("the token file must hold one token".into());
    }
    Ok(token)
}

/// The answer to one git credential prompt for github.com: GitHub's fixed user name for token
/// authentication, then the token as the password. A prompt for any other origin, or anything
/// else, is refused, so the token cannot be handed to a host a redirect or remote URL names.
pub fn answer(prompt: &str, contents: &str) -> Result<String, String> {
    let token = token(contents)?;
    if prompt == USERNAME_PROMPT {
        Ok("x-access-token".into())
    } else if prompt == PASSWORD_PROMPT {
        Ok(token.to_owned())
    } else {
        Err("not a credential prompt for https://github.com".into())
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

    #[test]
    fn refuses_a_prompt_for_any_other_origin() {
        for prompt in [
            "Password for 'https://x-access-token@foreign.example.invalid': ",
            "Password for 'https://x-access-token@github.com.foreign.example.invalid': ",
            "Password for 'http://x-access-token@github.com': ",
            "Username for 'https://foreign.example.invalid': ",
            "Password for 'https://someone@github.com': ",
            "Password: ",
        ] {
            assert!(answer(prompt, "tok").is_err(), "{prompt}");
        }
    }
}
