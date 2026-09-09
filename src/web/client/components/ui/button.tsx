import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";

type Appearance = { variant?: "outline" | "ghost"; size?: "sm" | "icon-sm" };

export function buttonVariants({ variant = "outline", size = "sm" }: Appearance = {}) {
  return `button button-${variant} button-${size}`;
}

export function Button({ className, variant, size, type = "button", ...props }: ComponentProps<"button"> & Appearance) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
