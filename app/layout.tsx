import type { Metadata } from 'next';
import './globals.css';
import './product.css';
import './remediation.css';

export const metadata: Metadata = {
  title: 'RwandAir Catering Control',
  description: 'Internal flight catering operations, reconciliation and stock control for RwandAir.',
  manifest: '/manifest.webmanifest',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
