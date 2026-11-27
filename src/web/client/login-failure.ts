import { useEffect, useState } from "react";
import { loginFailures } from "../login-return.js";

/** Keep a fixed recovery notice in the current page and remove it from shared links. */
export function useLoginFailure() {
  const [failure] = useState(() => {
    if (typeof location === "undefined") return;
    const code = new URLSearchParams(location.search).get("signin");
    return loginFailures.find(reason => reason === code);
  });
  useEffect(() => {
    if (!failure) return;
    const url = new URL(location.href);
    url.searchParams.delete("signin");
    history.replaceState(history.state, "", url);
  }, [failure]);
  return failure;
}
