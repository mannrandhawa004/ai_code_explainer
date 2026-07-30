import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}

export function abbreviate(value: string, visibleCharacters = 7): string {
  if (value.length <= visibleCharacters * 2 + 1) {
    return value;
  }
  return `${value.slice(0, visibleCharacters)}…${value.slice(-visibleCharacters)}`;
}
