//! Deterministic spoken editing for dictation.
//!
//! The parser intentionally prefers preserving literal speech over guessing.
//! Destructive commands are recognized only as complete utterances or at the
//! end of an utterance, while punctuation/structure phrases require clean word
//! boundaries. No model call is involved.
//!
//! Language policy: localized command tables apply only when the user has
//! explicitly selected that cleanup language in Settings. `Auto` (the default)
//! keeps the English commands and nothing else — applying every language's
//! table at once would fire on ordinary words across languages (Spanish
//! "coma" is the English word "coma", Italian/Spanish "punto" is everyday
//! vocabulary, German "eigentlich" is a filler), and the ASR layer gives us
//! no per-utterance language signal to gate on.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostAction {
    PressEnter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandLanguage {
    Auto,
    English,
    Spanish,
    French,
    German,
    Portuguese,
    Italian,
    Dutch,
    Polish,
}

impl CommandLanguage {
    pub fn from_code(code: &str) -> Self {
        match code {
            "en" => Self::English,
            "es" => Self::Spanish,
            "fr" => Self::French,
            "de" => Self::German,
            "pt" => Self::Portuguese,
            "it" => Self::Italian,
            "nl" => Self::Dutch,
            "pl" => Self::Polish,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessedTranscript {
    pub text: String,
    pub cancelled: bool,
    pub post_action: Option<PostAction>,
    pub applied_edits: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct SpokenCommandOptions {
    pub language: CommandLanguage,
    pub enabled: bool,
    pub corrections: bool,
    pub punctuation: bool,
    pub lists: bool,
    pub press_enter: bool,
}

impl Default for SpokenCommandOptions {
    fn default() -> Self {
        Self {
            language: CommandLanguage::Auto,
            enabled: true,
            corrections: true,
            punctuation: true,
            lists: true,
            press_enter: false,
        }
    }
}

pub fn process(text: &str, options: SpokenCommandOptions) -> ProcessedTranscript {
    if !options.enabled {
        return passthrough(text);
    }

    let mut value = text.trim().to_string();
    canonicalize_localized_commands(&mut value, options.language);
    let mut applied = Vec::new();
    let normalized = trim_terminal_punctuation(&value).to_ascii_lowercase();
    if normalized == "cancel that" {
        return ProcessedTranscript {
            text: String::new(),
            cancelled: true,
            post_action: None,
            applied_edits: vec!["cancel_that".into()],
        };
    }

    let mut post_action = None;
    if options.press_enter && strip_suffix_command(&mut value, "press enter") {
        post_action = Some(PostAction::PressEnter);
        applied.push("press_enter".into());
    }

    if options.corrections {
        if strip_suffix_command(&mut value, "delete last sentence") {
            value = delete_last_sentence(&value);
            applied.push("delete_last_sentence".into());
        } else if strip_suffix_command(&mut value, "delete last word") {
            value = delete_last_word(&value);
            applied.push("delete_last_word".into());
        }

        if replacement_pairs(options.language)
            .iter()
            .any(|(verb, joiner)| apply_explicit_replacement(&mut value, verb, joiner))
        {
            applied.push("explicit_replacement".into());
        }
        if apply_bounded_suffix_correction(&mut value, options.language) {
            applied.push("suffix_correction".into());
        }
        if remove_scratched_sentence(&mut value) {
            applied.push("scratch_that".into());
        }
    }

    if options.lists {
        let mut changed = false;
        changed |= replace_phrase(&mut value, "start a list", "\n- ");
        changed |= replace_phrase(&mut value, "next item", "\n- ");
        changed |= replace_phrase(&mut value, "end list", "\n");
        if changed {
            applied.push("list_structure".into());
        }
    }

    if options.punctuation {
        let replacements = [
            ("new paragraph", "\n\n"),
            ("new line", "\n"),
            ("question mark", "?"),
            ("full stop", "."),
            ("semicolon", ";"),
            ("colon", ":"),
            ("comma", ","),
            ("period", "."),
            ("open quote", "“"),
            ("close quote", "”"),
        ];
        let mut changed = false;
        for (spoken, replacement) in replacements {
            changed |= replace_phrase(&mut value, spoken, replacement);
        }
        if changed {
            applied.push("punctuation_structure".into());
        }
    }

    value = cleanup(&value);
    ProcessedTranscript {
        text: value,
        cancelled: false,
        post_action,
        applied_edits: applied,
    }
}

fn canonicalize_localized_commands(value: &mut String, language: CommandLanguage) {
    let replacements: &[(&str, &str)] = match language {
        CommandLanguage::Spanish => &[
            ("signo de interrogación", "question mark"),
            ("borra la última oración", "delete last sentence"),
            ("borra la última palabra", "delete last word"),
            ("iniciar una lista", "start a list"),
            ("siguiente elemento", "next item"),
            ("terminar la lista", "end list"),
            ("nuevo párrafo", "new paragraph"),
            ("nueva línea", "new line"),
            ("punto y coma", "semicolon"),
            ("dos puntos", "colon"),
            ("presiona enter", "press enter"),
            ("cancela eso", "cancel that"),
            ("tacha eso", "scratch that"),
            ("quiero decir", "i mean"),
            ("en realidad", "actually"),
            ("coma", "comma"),
            ("punto", "period"),
        ],
        CommandLanguage::French => &[
            ("point d'interrogation", "question mark"),
            ("supprime la dernière phrase", "delete last sentence"),
            ("supprime le dernier mot", "delete last word"),
            ("commencer une liste", "start a list"),
            ("élément suivant", "next item"),
            ("terminer la liste", "end list"),
            ("nouveau paragraphe", "new paragraph"),
            ("nouvelle ligne", "new line"),
            ("point-virgule", "semicolon"),
            ("deux-points", "colon"),
            ("appuie sur entrée", "press enter"),
            ("annule ça", "cancel that"),
            ("efface ça", "scratch that"),
            ("je veux dire", "i mean"),
            ("en fait", "actually"),
            ("virgule", "comma"),
            ("point", "period"),
        ],
        CommandLanguage::German => &[
            ("letzten satz löschen", "delete last sentence"),
            ("letztes wort löschen", "delete last word"),
            ("liste beginnen", "start a list"),
            ("nächster punkt", "next item"),
            ("liste beenden", "end list"),
            ("neuer absatz", "new paragraph"),
            ("neue zeile", "new line"),
            ("fragezeichen", "question mark"),
            ("doppelpunkt", "colon"),
            ("semikolon", "semicolon"),
            ("enter drücken", "press enter"),
            ("abbrechen", "cancel that"),
            ("streich das", "scratch that"),
            ("ich meine", "i mean"),
            ("eigentlich", "actually"),
            ("komma", "comma"),
            ("punkt", "period"),
        ],
        CommandLanguage::Portuguese => &[
            ("ponto de interrogação", "question mark"),
            ("apagar a última frase", "delete last sentence"),
            ("apagar a última palavra", "delete last word"),
            ("iniciar uma lista", "start a list"),
            ("próximo item", "next item"),
            ("terminar a lista", "end list"),
            ("novo parágrafo", "new paragraph"),
            ("nova linha", "new line"),
            ("ponto e vírgula", "semicolon"),
            ("dois pontos", "colon"),
            ("pressionar enter", "press enter"),
            ("cancela isso", "cancel that"),
            ("risca isso", "scratch that"),
            ("quero dizer", "i mean"),
            ("na verdade", "actually"),
            ("vírgula", "comma"),
            ("ponto", "period"),
        ],
        CommandLanguage::Italian => &[
            ("punto interrogativo", "question mark"),
            ("cancella l'ultima frase", "delete last sentence"),
            ("cancella l'ultima parola", "delete last word"),
            ("inizia un elenco", "start a list"),
            ("elemento successivo", "next item"),
            ("termina l'elenco", "end list"),
            ("nuovo paragrafo", "new paragraph"),
            ("nuova riga", "new line"),
            ("a capo", "new line"),
            ("punto e virgola", "semicolon"),
            ("due punti", "colon"),
            ("premi invio", "press enter"),
            ("annulla questo", "cancel that"),
            ("cancella questo", "scratch that"),
            ("voglio dire", "i mean"),
            ("in realtà", "actually"),
            ("virgola", "comma"),
            ("punto", "period"),
        ],
        CommandLanguage::Dutch => &[
            ("vraagteken", "question mark"),
            ("verwijder de laatste zin", "delete last sentence"),
            ("verwijder het laatste woord", "delete last word"),
            ("begin een lijst", "start a list"),
            ("volgend item", "next item"),
            ("einde lijst", "end list"),
            ("nieuwe alinea", "new paragraph"),
            ("nieuwe regel", "new line"),
            ("puntkomma", "semicolon"),
            ("dubbele punt", "colon"),
            ("druk op enter", "press enter"),
            ("annuleer dat", "cancel that"),
            ("schrap dat", "scratch that"),
            ("ik bedoel", "i mean"),
            ("eigenlijk", "actually"),
            ("komma", "comma"),
            ("punt", "period"),
        ],
        CommandLanguage::Polish => &[
            ("znak zapytania", "question mark"),
            ("usuń ostatnie zdanie", "delete last sentence"),
            ("usuń ostatnie słowo", "delete last word"),
            ("rozpocznij listę", "start a list"),
            ("następny element", "next item"),
            ("zakończ listę", "end list"),
            ("nowy akapit", "new paragraph"),
            ("nowa linia", "new line"),
            ("średnik", "semicolon"),
            ("dwukropek", "colon"),
            ("naciśnij enter", "press enter"),
            ("anuluj to", "cancel that"),
            ("skreśl to", "scratch that"),
            ("to znaczy", "i mean"),
            ("właściwie", "actually"),
            ("przecinek", "comma"),
            ("kropka", "period"),
        ],
        // Auto deliberately gets no localized table — see the module docs.
        CommandLanguage::Auto | CommandLanguage::English => &[],
    };
    for (localized, canonical) in replacements {
        replace_phrase(value, localized, canonical);
    }
}

/// "change X to Y" / "replace X with Y" verb+joiner pairs. Unlike the fixed
/// phrases above these carry free-form arguments, so they cannot be
/// canonicalized up front and are matched per-language instead. English pairs
/// stay active everywhere so mixed-language dictation keeps working.
fn replacement_pairs(language: CommandLanguage) -> &'static [(&'static str, &'static str)] {
    const ENGLISH: [(&str, &str); 2] = [("change", "to"), ("replace", "with")];
    match language {
        CommandLanguage::Auto | CommandLanguage::English => &ENGLISH,
        CommandLanguage::Spanish => &[
            ENGLISH[0],
            ENGLISH[1],
            ("cambia", "por"),
            ("cambia", "a"),
            ("reemplaza", "por"),
            ("reemplaza", "con"),
        ],
        CommandLanguage::French => &[
            ENGLISH[0],
            ENGLISH[1],
            ("change", "en"),
            ("remplace", "par"),
        ],
        CommandLanguage::German => &[
            ENGLISH[0],
            ENGLISH[1],
            ("ändere", "zu"),
            ("ersetze", "durch"),
        ],
        CommandLanguage::Portuguese => &[
            ENGLISH[0],
            ENGLISH[1],
            ("mude", "para"),
            ("troque", "por"),
            ("substitua", "por"),
        ],
        CommandLanguage::Italian => &[
            ENGLISH[0],
            ENGLISH[1],
            ("cambia", "in"),
            ("cambia", "con"),
            ("sostituisci", "con"),
        ],
        CommandLanguage::Dutch => &[
            ENGLISH[0],
            ENGLISH[1],
            ("verander", "in"),
            ("vervang", "door"),
        ],
        CommandLanguage::Polish => &[
            ENGLISH[0],
            ENGLISH[1],
            ("zmień", "na"),
            ("zamień", "na"),
        ],
    }
}

fn passthrough(text: &str) -> ProcessedTranscript {
    ProcessedTranscript {
        text: text.to_string(),
        cancelled: false,
        post_action: None,
        applied_edits: Vec::new(),
    }
}

fn trim_terminal_punctuation(value: &str) -> &str {
    value
        .trim()
        .trim_end_matches(['.', ',', '!', '?', ';', ':'])
}

fn strip_suffix_command(value: &mut String, command: &str) -> bool {
    let trimmed = value.trim_end();
    let without_punct = trim_terminal_punctuation(trimmed);
    let lower = without_punct.to_ascii_lowercase();
    if lower == command {
        value.clear();
        return true;
    }
    let suffix = format!(" {command}");
    if lower.ends_with(&suffix) {
        let keep_len = without_punct.len() - suffix.len();
        value.truncate(keep_len);
        *value = value
            .trim_end_matches([' ', ',', '.', ';', ':'])
            .to_string();
        return true;
    }
    false
}

/// Replace whole-word occurrences of `phrase` (lowercase) in `value`,
/// case-insensitively. Folding is per-character Unicode lowercase so accented
/// command words match however ASR capitalized them ("Średnik", "Élément") —
/// ASCII-only lowercasing would miss a leading non-ASCII capital.
fn replace_phrase(value: &mut String, phrase: &str, replacement: &str) -> bool {
    let phrase: Vec<char> = phrase.chars().collect();
    if phrase.is_empty() {
        return false;
    }
    let chars: Vec<(usize, char)> = value.char_indices().collect();
    let mut ranges = Vec::new();
    let mut i = 0;
    while i + phrase.len() <= chars.len() {
        let matched = phrase.iter().enumerate().all(|(k, pc)| {
            let vc = chars[i + k].1;
            vc == *pc || vc.to_lowercase().next() == Some(*pc)
        });
        if matched {
            let after = i + phrase.len();
            let left_ok = i == 0 || !is_word_char(chars[i - 1].1);
            let right_ok = after == chars.len() || !is_word_char(chars[after].1);
            if left_ok && right_ok {
                let start = chars[i].0;
                let end = chars.get(after).map(|(idx, _)| *idx).unwrap_or(value.len());
                ranges.push((start, end));
                i = after;
                continue;
            }
        }
        i += 1;
    }
    if ranges.is_empty() {
        return false;
    }
    for (start, end) in ranges.into_iter().rev() {
        value.replace_range(start..end, replacement);
    }
    true
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '\''
}

fn apply_explicit_replacement(value: &mut String, verb: &str, joiner: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let marker = format!(" {verb} ");
    let Some(command_at) = lower.rfind(&marker) else {
        return false;
    };
    let command = &value[command_at + marker.len()..];
    let command_lower = command.to_ascii_lowercase();
    let separator = format!(" {joiner} ");
    let Some(split_at) = command_lower.find(&separator) else {
        return false;
    };
    let old = command[..split_at].trim();
    let new = command[split_at + separator.len()..].trim();
    if old.is_empty() || new.is_empty() || old.split_whitespace().count() > 8 {
        return false;
    }
    let prefix = value[..command_at].trim_end();
    let prefix_lower = prefix.to_ascii_lowercase();
    let old_lower = old.to_ascii_lowercase();
    let Some(old_at) = prefix_lower.rfind(&old_lower) else {
        return false;
    };
    let old_end = old_at + old.len();
    let left_ok = old_at == 0 || !is_word_char(prefix[..old_at].chars().next_back().unwrap());
    let right_ok =
        old_end == prefix.len() || !is_word_char(prefix[old_end..].chars().next().unwrap());
    if !left_ok || !right_ok {
        return false;
    }
    let mut out = prefix.to_string();
    out.replace_range(old_at..old_end, new);
    *value = out;
    true
}

fn apply_bounded_suffix_correction(value: &mut String, language: CommandLanguage) -> bool {
    let lower = value.to_ascii_lowercase();
    // " actually " and " i mean " are canonical literals (the localized tables
    // rewrite into them). Bare " no " is a correction marker only for explicit
    // English: it is the negation word in Spanish/Portuguese/Italian (and a
    // particle in Polish), so under Auto or a non-English language it would
    // silently delete the word before an ordinary "no".
    let markers: &[&str] = if language == CommandLanguage::English {
        &[" actually ", " i mean ", " no "]
    } else {
        &[" actually ", " i mean "]
    };
    let marker = markers
        .iter()
        .copied()
        .filter_map(|m| lower.rfind(m).map(|at| (at, m)))
        .max_by_key(|(at, _)| *at);
    let Some((at, marker)) = marker else {
        return false;
    };
    let suffix = value[at + marker.len()..].trim();
    if suffix.is_empty() || suffix.split_whitespace().count() > 4 {
        return false;
    }
    let prefix = value[..at].trim_end();
    let corrected_prefix = delete_last_word(prefix);
    *value = if corrected_prefix.is_empty() {
        suffix.to_string()
    } else {
        format!("{corrected_prefix} {suffix}")
    };
    true
}

fn remove_scratched_sentence(value: &mut String) -> bool {
    let lower = value.to_ascii_lowercase();
    let Some(at) = lower.rfind("scratch that") else {
        return false;
    };
    let end = at + "scratch that".len();
    let left_ok = at == 0 || !is_word_char(value[..at].chars().next_back().unwrap());
    let right_ok = end == value.len() || !is_word_char(value[end..].chars().next().unwrap());
    if !left_ok || !right_ok {
        return false;
    }
    let before = value[..at].trim_end_matches(|ch: char| ch.is_whitespace() || ch == ',');
    let after =
        value[end..].trim_start_matches(|ch: char| ch.is_whitespace() || ch.is_ascii_punctuation());
    let boundary = before
        .char_indices()
        .rev()
        .find(|(_, ch)| matches!(ch, '.' | '!' | '?' | '\n'))
        .map(|(idx, ch)| idx + ch.len_utf8())
        .unwrap_or(0);
    let kept = &before[..boundary];
    *value = if kept.is_empty() || after.is_empty() || kept.ends_with(char::is_whitespace) {
        format!("{kept}{after}")
    } else {
        format!("{kept} {after}")
    };
    true
}

fn delete_last_word(value: &str) -> String {
    value
        .trim_end_matches(|ch: char| ch.is_whitespace() || ch.is_ascii_punctuation())
        .rsplit_once(char::is_whitespace)
        .map(|(head, _)| head.trim_end().to_string())
        .unwrap_or_default()
}

fn delete_last_sentence(value: &str) -> String {
    let trimmed =
        value.trim_end_matches(|ch: char| ch.is_whitespace() || ch.is_ascii_punctuation());
    trimmed
        .char_indices()
        .rev()
        .find(|(_, ch)| matches!(ch, '.' | '!' | '?' | '\n'))
        .map(|(idx, ch)| trimmed[..idx + ch.len_utf8()].trim_end().to_string())
        .unwrap_or_default()
}

fn cleanup(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for ch in value.trim().chars() {
        if ch == '\n' {
            while out.ends_with(' ') {
                out.pop();
            }
            out.push('\n');
            pending_space = false;
        } else if ch.is_whitespace() {
            pending_space = true;
        } else {
            if pending_space
                && !out.is_empty()
                && !out.ends_with('\n')
                && !matches!(ch, ',' | '.' | '!' | '?' | ';' | ':' | '”')
                && !out.ends_with('“')
            {
                out.push(' ');
            }
            out.push(ch);
            pending_space = false;
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_requires_the_whole_utterance() {
        assert!(process("cancel that.", SpokenCommandOptions::default()).cancelled);
        assert!(
            !process(
                "Please cancel that appointment",
                SpokenCommandOptions::default()
            )
            .cancelled
        );
    }

    #[test]
    fn expands_punctuation_and_paragraphs() {
        let out = process(
            "Hello comma world new paragraph Next thought period",
            SpokenCommandOptions::default(),
        );
        assert_eq!(out.text, "Hello, world\n\nNext thought.");
    }

    #[test]
    fn creates_a_list() {
        let out = process(
            "start a list apples next item pears next item plums end list done",
            SpokenCommandOptions::default(),
        );
        assert_eq!(out.text, "- apples\n- pears\n- plums\ndone");
    }

    #[test]
    fn replaces_an_exact_prior_phrase() {
        let out = process(
            "Meet Alice tomorrow change Alice to Amandine",
            SpokenCommandOptions::default(),
        );
        assert_eq!(out.text, "Meet Amandine tomorrow");
    }

    #[test]
    fn corrects_only_a_short_suffix() {
        let out = process(
            "Send it Tuesday actually Wednesday",
            SpokenCommandOptions::default(),
        );
        assert_eq!(out.text, "Send it Wednesday");
    }

    #[test]
    fn scratch_that_removes_the_current_sentence() {
        let out = process(
            "Keep this. Remove this thought scratch that Keep this too",
            SpokenCommandOptions::default(),
        );
        assert_eq!(out.text, "Keep this. Keep this too");
    }

    #[test]
    fn press_enter_is_opt_in_and_terminal_only() {
        let off = process("Send it press enter", SpokenCommandOptions::default());
        assert_eq!(off.text, "Send it press enter");
        let on = process(
            "Send it press enter",
            SpokenCommandOptions {
                press_enter: true,
                ..Default::default()
            },
        );
        assert_eq!(on.text, "Send it");
        assert_eq!(on.post_action, Some(PostAction::PressEnter));
        let literal = process(
            "Press enter to submit the form",
            SpokenCommandOptions {
                press_enter: true,
                ..Default::default()
            },
        );
        assert_eq!(literal.post_action, None);
    }

    #[test]
    fn supports_unicode_text() {
        let out = process(
            "Bonjour Chloé comma ça va question mark",
            SpokenCommandOptions::default(),
        );
        assert_eq!(out.text, "Bonjour Chloé, ça va?");
    }

    #[test]
    fn supports_localized_structure_commands() {
        let out = process(
            "Bonjour virgule Chloé nouvelle ligne à demain point",
            SpokenCommandOptions {
                language: CommandLanguage::French,
                ..Default::default()
            },
        );
        assert_eq!(out.text, "Bonjour, Chloé\nà demain.");
    }

    fn options_for(language: CommandLanguage) -> SpokenCommandOptions {
        SpokenCommandOptions {
            language,
            ..Default::default()
        }
    }

    #[test]
    fn supports_italian_commands() {
        let out = process(
            "Ciao Marco virgola a capo ci vediamo domani punto",
            options_for(CommandLanguage::Italian),
        );
        assert_eq!(out.text, "Ciao Marco,\nci vediamo domani.");
    }

    #[test]
    fn supports_dutch_commands() {
        let out = process(
            "Hallo Anna komma nieuwe regel tot morgen punt",
            options_for(CommandLanguage::Dutch),
        );
        assert_eq!(out.text, "Hallo Anna,\ntot morgen.");
    }

    #[test]
    fn supports_polish_commands() {
        let out = process(
            "Cześć Marku przecinek nowa linia do jutra kropka",
            options_for(CommandLanguage::Polish),
        );
        assert_eq!(out.text, "Cześć Marku,\ndo jutra.");
    }

    #[test]
    fn matches_commands_with_non_ascii_capitalization() {
        // ASCII lowercasing would leave a leading "Ś" untouched and miss this.
        let out = process(
            "Średnik",
            options_for(CommandLanguage::Polish),
        );
        assert_eq!(out.text, ";");
    }

    #[test]
    fn auto_keeps_localized_words_literal() {
        let out = process(
            "arriviamo al punto e virgola decisiva",
            options_for(CommandLanguage::Auto),
        );
        assert_eq!(out.text, "arriviamo al punto e virgola decisiva");
    }

    #[test]
    fn bare_no_correction_is_english_only() {
        let en = process(
            "Send it Tuesday no Wednesday",
            options_for(CommandLanguage::English),
        );
        assert_eq!(en.text, "Send it Wednesday");
        // Spanish negation must survive: " no " is not a correction marker.
        let es = process(
            "Creo que no vamos hoy",
            options_for(CommandLanguage::Spanish),
        );
        assert_eq!(es.text, "Creo que no vamos hoy");
        // Auto (default) is multilingual-unknown, so it is excluded too.
        let auto = process(
            "Send it Tuesday no Wednesday",
            options_for(CommandLanguage::Auto),
        );
        assert_eq!(auto.text, "Send it Tuesday no Wednesday");
    }

    #[test]
    fn supports_localized_explicit_replacement() {
        let it = process(
            "Vediamo Alice domani cambia Alice con Marta",
            options_for(CommandLanguage::Italian),
        );
        assert_eq!(it.text, "Vediamo Marta domani");
        let pl = process(
            "Spotkanie we wtorek zmień wtorek na środę",
            options_for(CommandLanguage::Polish),
        );
        assert_eq!(pl.text, "Spotkanie we środę");
    }

    #[test]
    fn supports_localized_scratch_that() {
        let out = process(
            "Dit blijft. Dit moet weg schrap dat Dit ook",
            options_for(CommandLanguage::Dutch),
        );
        assert_eq!(out.text, "Dit blijft. Dit ook");
    }
}
