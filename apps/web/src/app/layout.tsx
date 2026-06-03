import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FAKTURIO",
  description: "Autonomous invoice control and soft-collection dashboard"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="sk">
      <body>{children}</body>
    </html>
  );
}
