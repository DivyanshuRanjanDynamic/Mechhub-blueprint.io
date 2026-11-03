import { useMemo, useState } from "react";
import type { Blueprint } from "../../shared/types.ts";
import { download, fileSafe } from "../api.ts";

const KEYWORDS = /\b(void|int|float|const|char|bool|uint8_t|unsigned|long|volatile|if|else|for|while|return|true|false|static|auto)\b/g;

function highlight(code: string): string {
  const esc = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Tokenise comments and strings first so keyword colouring never touches them
  return esc
    .split(/(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*")/g)
    .map((part) => {
      if (part.startsWith("/*") || part.startsWith("//")) return `<span class="c-com">${part}</span>`;
      if (part.startsWith('"')) return `<span class="c-str">${part}</span>`;
      return part
        .replace(/^(#\w+)/gm, '<span class="c-pre">$1</span>')
        .replace(KEYWORDS, '<span class="c-kw">$1</span>')
        .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="c-num">$1</span>');
    })
    .join("");
}

export default function CodeTab({ bp }: { bp: Blueprint }) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => highlight(bp.firmware), [bp.firmware]);
  const libs = bp.firmware.match(/Libraries: (.*)/)?.[1];
  return (
    <div className="code">
      <div className="toolbar">
        <p className="muted">
          Arduino sketch for this exact pin map{libs ? ` · needs: ${libs}` : ""}
        </p>
        <div className="row-gap">
          <button
            className="btn"
            onClick={() => {
              navigator.clipboard?.writeText(bp.firmware);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="btn primary" onClick={() => download(`${fileSafe(bp.plan.title)}.ino`, bp.firmware, "text/plain")}>
            Download .ino
          </button>
        </div>
      </div>
      <pre className="code-block">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
