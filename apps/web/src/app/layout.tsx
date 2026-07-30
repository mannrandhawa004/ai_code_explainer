import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Codebase Explainer",
    template: "%s · Codebase Explainer",
  },
  description:
    "Ask grounded questions about an indexed repository and inspect the exact source lines behind every answer.",
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f4f6f1",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
