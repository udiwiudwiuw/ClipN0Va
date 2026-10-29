import type { Metadata } from "next";
import { MobileNav, Sidebar } from "@/components/sidebar";
import { ToastProvider } from "@/components/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipNova Posting Bot",
  description: "Plan en publiceer clips automatisch op TikTok, YouTube Shorts en Instagram Reels.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl">
      <body>
        <ToastProvider>
          <div className="flex min-h-screen">
            <Sidebar />
            <div className="min-w-0 flex-1">
              <MobileNav />
              <main className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">{children}</main>
            </div>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
