import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fragments v2',
  description: 'Versioned REST API for text and image fragments. Next.js, TypeScript, PostgreSQL.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
