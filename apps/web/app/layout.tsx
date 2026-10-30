import type { Metadata } from "next";
import "./globals.css";
import { LocaleProvider } from "@/lib/i18n";
import { ClientProvider } from "@/lib/client";
import { Shell } from "@/components/shell";
export const metadata: Metadata = {
  title: "Dreamwalk",
  description: "Dreamwalk adventure platform",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body>
        <LocaleProvider>
          <ClientProvider>
            <Shell>{children}</Shell>
          </ClientProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
