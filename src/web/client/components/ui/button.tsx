import type { ComponentProps } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { buttonVariants as kumoButtonVariants } from "@cloudflare/kumo/components/button";
import { cn } from "../../lib/utils.js";

type Appearance = { variant?: "primary" | "outline" | "ghost"; size?: "sm" | "icon-sm" };

export function buttonVariants({ variant = "outline", size = "sm" }: Appearance = {}) {
  return cn(kumoButtonVariants({ variant: variant === "outline" ? "secondary" : variant, size: "base", shape: size === "icon-sm" ? "square" : "base" }), `button button-${variant} button-${size}`);
}

export function Button({ className, variant, size, type = "button", ...props }: ComponentProps<"button"> & Appearance) {
  return <BaseButton type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
