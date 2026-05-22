import type { Metadata } from "next";
import "./globals.css";
import ChunkErrorReloader from "@/components/ChunkErrorReloader";

export const metadata: Metadata = {
  title: "DA Platform",
  description: "DealerAddendums Platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Newsreader:ital,wght@0,400;0,500;1,400&family=JetBrains+Mono:wght@400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        {/* Mounts last so its (null-returning) Client Component boundary
            sits after the route segment's children in React's tree, not
            before — keeping the route children's hydration index stable. */}
        <ChunkErrorReloader />
      </body>
    </html>
  );
}
