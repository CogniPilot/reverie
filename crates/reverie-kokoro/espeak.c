/* Process adapter for the native eSpeak NG API. Text arrives only on stdin.
 * Calling TextToPhonemes preserves the pre-synthesis IPA used by the model.
 */
#include <espeak-ng/speak_lib.h>
#include <stdio.h>
#include <string.h>

enum { MAX_TEXT_BYTES = 600 * 4 };

static int select_language(const char *language) {
    const espeak_VOICE **voices = espeak_ListVoices(NULL);
    if (voices == NULL) {
        return 1;
    }
    for (const espeak_VOICE **entry = voices; *entry != NULL; ++entry) {
        const espeak_VOICE *voice = *entry;
        // The leading byte is priority; the first name is the primary language.
        const char *codes = voice->languages;
        if (codes != NULL && codes[0] != '\0' && strcmp(codes + 1, language) == 0 &&
            voice->identifier != NULL && strncmp(voice->identifier, "mb/", 3) != 0) {
            return espeak_SetVoiceByName(voice->identifier) != EE_OK;
        }
    }
    return 1;
}

static int phonemes(const char *text) {
    const void *cursor = text;
    const int ipa_with_separator = 2 | ('_' << 8);
    for (size_t count = 0; cursor != NULL && count <= MAX_TEXT_BYTES; ++count) {
        const void *before = cursor;
        const char *ipa = espeak_TextToPhonemes(&cursor, espeakCHARS_UTF8, ipa_with_separator);
        if (ipa == NULL || cursor == before || fputs(ipa, stdout) == EOF ||
            fputc('\n', stdout) == EOF) {
            return 1;
        }
    }
    return cursor != NULL || fflush(stdout) == EOF;
}

int main(int argc, char *argv[]) {
    char text[MAX_TEXT_BYTES + 1];
    const size_t length = fread(text, 1, sizeof text, stdin);
    if (argc != 2 || length == 0 || length > MAX_TEXT_BYTES || ferror(stdin) ||
        memchr(text, '\0', length) != NULL) {
        return 1;
    }
    text[length] = '\0';
    if (espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, NULL, espeakINITIALIZE_DONT_EXIT) <= 0) {
        return 1;
    }
    const int failed = select_language(argv[1]) || phonemes(text);
    espeak_Terminate();
    return failed;
}
