import { useState } from "react";

export function useClipboard() {
  const [notice, setNotice] = useState<{
    message: string;
    tone: "danger" | "success";
  }>();
  async function copy(text: string, message = "Copied to clipboard.") {
    setNotice(undefined);
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ message, tone: "success" });
    } catch {
      setNotice({
        message: "Copy failed. Select it and copy manually.",
        tone: "danger",
      });
    }
  }
  return { copy, notice };
}
