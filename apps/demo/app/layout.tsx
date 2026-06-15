import type { ReactNode } from "react";
import { ConvexClientProvider } from "./ConvexClientProvider";

export const metadata = {
  title: "NotChat CRM",
  description: "Demo for convex-sync-motherduck",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 24 }}>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
