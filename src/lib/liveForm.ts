export type FormField = {
  id: string;
  name: string;
  format: "text" | "long" | "email" | "number" | "date" | "choice";
  instructions: string;
  required: boolean;
  choices: string[];
};

export type FormConfig = {
  fields: FormField[];
  speaker: "you" | "them" | "all";
  uncertainty: "review" | "empty";
  explicit_only: boolean;
  protect_manual: boolean;
  show_evidence: boolean;
};

export type FormAnswer = {
  id: string;
  value: string;
  status: "captured" | "review" | "manual";
  quote: string;
  speaker: string;
  start_ms: number;
  end_ms: number;
};

export function starterForm(): FormConfig {
  return {
    fields: [
      { id: "name", name: "Name", format: "text", instructions: "Their full name, when they introduce themselves.", required: true, choices: [] },
      { id: "email", name: "Email", format: "email", instructions: "Their preferred email address. Capture exact spelling; flag ambiguous spelling for review.", required: true, choices: [] },
      { id: "industry", name: "Industry", format: "text", instructions: "The industry their company operates in, as they describe it.", required: true, choices: [] },
      { id: "motivation", name: "Motivation", format: "long", instructions: "The specific problem or desired outcome motivating them to look for a solution.", required: true, choices: [] },
      { id: "product", name: "Product of interest", format: "text", instructions: "The product or plan they explicitly say they are interested in.", required: true, choices: [] },
    ], speaker: "them", uncertainty: "review", explicit_only: true, protect_manual: true, show_evidence: true,
  };
}

export function parseFormConfig(notes: string): FormConfig | null {
  try {
    const value = JSON.parse(notes) as FormConfig;
    if (!Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 12
      || !["you", "them", "all"].includes(value.speaker) || !["review", "empty"].includes(value.uncertainty)
      || [value.explicit_only, value.protect_manual, value.show_evidence].some(v => typeof v !== "boolean")) return null;
    const ids = new Set<string>();
    for (const f of value.fields) {
      if (!f || typeof f.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(f.id) || ids.has(f.id)
        || typeof f.name !== "string" || !f.name.trim() || typeof f.instructions !== "string" || !f.instructions.trim()
        || !["text", "long", "email", "number", "date", "choice"].includes(f.format)
        || typeof f.required !== "boolean" || !Array.isArray(f.choices) || f.choices.some(c => typeof c !== "string")) return null;
      ids.add(f.id);
    }
    return value;
  } catch { return null; }
}

export function formProgress(config: FormConfig, answers: FormAnswer[]) {
  const filled = (f: FormField) => answers.some(a => a.id === f.id && a.value.trim() && a.status !== "review");
  return { filled: config.fields.filter(filled).length, total: config.fields.length,
    review: config.fields.filter(f => answers.some(a => a.id === f.id && a.status === "review")).length,
    requiredComplete: config.fields.filter(f => f.required).every(filled) };
}

export function formTimestamp(ms: number): string {
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
}
