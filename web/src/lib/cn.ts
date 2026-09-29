import { clsx, type ClassValue } from "clsx";

// Join class names, skipping falsy ones: cn("a", isActive && "b").
export function cn(...values: ClassValue[]): string {
  return clsx(values);
}
