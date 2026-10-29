import type { Metadata } from "next";
import { Header } from "@/components/header";
import { ToastProvider } from "@/components/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipNova Campaign Video Finder",
  description: "Vind en scoor bronvideo's voor clipcampagnes met AI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl">
      <body>
        <ToastProvider>
          <Header />
          <main className="mx-auto max-w-[1500px] px-4 py-6 md:px-8">{children}</main>
        </ToastProvider>
      </body>
    </html>
  );
}
