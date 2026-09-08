"use client";

import { useState } from "react";
import { Loader2, SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useTeachCast } from "@/lib/store";

const MAX_LENGTH = 2000;

export function PromptBox() {
  const [value, setValue] = useState("");
  const sendMessage = useTeachCast((s) => s.sendMessage);
  const sending = useTeachCast((s) => s.sending);
  const activeChatId = useTeachCast((s) => s.activeChatId);

  const canSend = value.trim().length > 0 && !sending && activeChatId !== null;

  const submit = () => {
    if (!canSend) return;
    const text = value.trim();
    setValue("");
    void sendMessage(text);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="shrink-0 border-t p-3 md:p-4"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
        <div className="flex items-end gap-2 rounded-xl border bg-card p-2 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/40">
          <Textarea
            value={value}
            maxLength={MAX_LENGTH}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Describe the app you want to build"
            aria-label="Message"
            className="field-sizing-content max-h-44 min-h-11 flex-1 resize-none border-0 bg-transparent p-2.5 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0 placeholder:text-muted-foreground"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!canSend}
            aria-label={sending ? "Sending message" : "Send message"}
            className="h-11 w-11 shrink-0"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <SendHorizontal className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        </div>
        <p className="px-1 text-[11px] text-muted-foreground">
          Enter sends · Shift+Enter adds a new line
        </p>
      </div>
    </form>
  );
}
