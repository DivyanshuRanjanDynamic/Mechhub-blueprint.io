import { useEffect, useRef, useState } from "react";
import type { Preferences, Project } from "../../shared/types.ts";
import { PROVIDER_NAME } from "../api.ts";

const SUGGESTIONS = ["Make it cheaper", "Add an OLED display", "Run it on battery", "Switch to Arduino Nano", "Add a buzzer for alerts"];

export default function Chat({ project, busy, onSend }: { project: Project; busy: boolean; onSend: (text: string, answers?: Preferences) => void }) {
  const [text, setText] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const endRef = useRef<HTMLDivElement>(null);
  const clarifying = project.status === "clarifying";
  const lastQuestions = clarifying ? [...project.messages].reverse().find((m) => m.questions?.length)?.questions : undefined;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [project.messages.length, busy]);

  function submit() {
    if (busy) return;
    if (clarifying) {
      onSend(text.trim(), answers as Preferences);
      setText("");
      return;
    }
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <h2>Design chat</h2>
        <span className="muted">{project.blueprint ? `${PROVIDER_NAME[project.blueprint.engine] ?? "Offline"} planner` : "Clarifying"}</span>
      </div>
      <div className="chat-log">
        {project.messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">{m.text}</div>
            {m.questions && clarifying && m.questions === lastQuestions && (
              <div className="questions">
                {m.questions.map((q) => (
                  <fieldset key={q.id} className="question">
                    <legend>{q.text}</legend>
                    <div className="opts">
                      {q.options.map((o) => (
                        <button
                          key={o}
                          type="button"
                          className={`chip ${answers[q.id] === o ? "on" : ""}`}
                          aria-pressed={answers[q.id] === o}
                          onClick={() => setAnswers((a) => ({ ...a, [q.id]: a[q.id] === o ? "" : o }))}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                ))}
                <button className="btn primary block" onClick={submit} disabled={busy}>
                  {busy ? "Designing…" : Object.values(answers).some(Boolean) ? "Generate blueprint" : "Generate now with defaults"}
                </button>
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="msg assistant">
            <div className="bubble typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {!clarifying && (
        <div className="chips small">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" disabled={busy} onClick={() => onSend(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          rows={2}
          value={text}
          placeholder={clarifying ? "Anything else I should know? (optional)" : "Ask for a change: “add a second ultrasonic sensor”…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Message"
        />
        <button className="btn primary" disabled={busy || (!clarifying && !text.trim())}>
          Send
        </button>
      </form>
    </div>
  );
}
