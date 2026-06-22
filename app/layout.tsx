import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import ChunkErrorReloader from "@/components/ChunkErrorReloader";
import { resolveBrandForHost, brandCssVars } from "@/lib/brand";
import { BrandProvider } from "@/contexts/Brand";

// Host-driven white-label branding (Phase 12a) makes rendering depend on the
// request host, so metadata + the layout resolve per-request (cached per host).
export async function generateMetadata(): Promise<Metadata> {
  const brand = await resolveBrandForHost(headers().get("host"));
  return {
    title: brand.displayName,
    description: brand.isDefault ? "DealerAddendums Platform" : `${brand.displayName} Platform`,
    ...(brand.faviconUrl ? { icons: { icon: brand.faviconUrl } } : {}),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const brand = await resolveBrandForHost(headers().get("host"));
  const brandCss = brandCssVars(brand);

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Newsreader:ital,wght@0,400;0,500;1,400&family=JetBrains+Mono:wght@400&display=swap"
          rel="stylesheet"
        />
        {/* Reseller theme: retint primary/accent tokens for a branded host only.
            Structural design-system tokens (navy chrome, cards, spacing) stay. */}
        {brandCss && <style id="brand-theme" dangerouslySetInnerHTML={{ __html: brandCss }} />}
      </head>
      <body>
        <BrandProvider
          brand={{
            displayName: brand.displayName,
            logoUrl: brand.logoUrl,
            primaryColor: brand.primaryColor,
            accentColor: brand.accentColor,
            isDefault: brand.isDefault,
          }}
        >
          {children}
        </BrandProvider>
        {/* Mounts last so its (null-returning) Client Component boundary
            sits after the route segment's children in React's tree, not
            before — keeping the route children's hydration index stable. */}
        <ChunkErrorReloader />
      </body>
    </html>
  );
}
