//! GBNF grammar constraining meeting synthesis output to strict JSON.

pub const MEETING_SYNTHESIS_GBNF: &str = r#"
root         ::= "{" ws "\"summary\"" ws ":" ws summary ws "," ws "\"action_items\"" ws ":" ws actions ws "," ws "\"suggested_title\"" ws ":" ws string ws "}"

summary      ::= "[" ws ( string ( ws "," ws string ){2,4} )? ws "]"

actions      ::= "[" ws ( action ( ws "," ws action )* )? ws "]"

action       ::= "{" ws "\"text\"" ws ":" ws string ws "," ws "\"owner\"" ws ":" ws owner ws "}"

owner        ::= "\"you\"" | "\"them\"" | "\"unspecified\""

string       ::= "\"" char* "\""
char         ::= [^"\\] | "\\" ( ["\\/bfnrt] | "u" hex hex hex hex )
hex          ::= [0-9a-fA-F]
ws           ::= [ \t\n]*
"#;
