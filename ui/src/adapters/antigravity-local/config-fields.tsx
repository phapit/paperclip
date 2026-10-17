import { configFieldsForSection } from "../config-sections";
import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftInput,
  Field,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Prepended to the Antigravity prompt at runtime.";

const accountHomesHint =
  "Optional. Comma-separated absolute profile HOMEs to rotate through when an account runs out of quota, or the single word auto for every signed-in profile under $PAPERCLIP_HOME/antigravity-accounts. Local runs only.";

function readAccountHomes(value: unknown): string {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(", ");
  return typeof value === "string" ? value : "";
}

export function AntigravityLocalConfigFields({
  section,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  if (hideInstructionsFile) return null;
  return configFieldsForSection(section, (
    <>
      {!isCreate && (
        <Field label="Account pool (profile HOMEs)" hint={accountHomesHint}>
          <DraftInput
            value={readAccountHomes(eff("adapterConfig", "accountHomes", config.accountHomes))}
            onCommit={(v) => {
              const homes = v
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean);
              mark("adapterConfig", "accountHomes", homes.length > 0 ? homes : undefined);
            }}
            immediate
            className={inputClass}
            placeholder="auto  or  /paperclip/antigravity-accounts/acc1, /paperclip/antigravity-accounts/acc2"
          />
        </Field>
      )}
      <Field label="Agent instructions file" hint={instructionsFileHint}>
        <div className="flex items-center gap-2">
          <DraftInput
            value={
              isCreate
                ? values!.instructionsFilePath ?? ""
                : eff(
                    "adapterConfig",
                    "instructionsFilePath",
                    String(config.instructionsFilePath ?? ""),
                  )
            }
            onCommit={(v) =>
              isCreate
                ? set!({ instructionsFilePath: v })
                : mark("adapterConfig", "instructionsFilePath", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="/absolute/path/to/AGENTS.md"
          />
          <ChoosePathButton />
        </div>
      </Field>
    </>
  ));
}
