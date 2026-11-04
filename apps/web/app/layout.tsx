import type { Metadata } from 'next';
import './globals.css';
import './design-system.css';
import './auth-design.css';
import { LocaleProvider } from '@/lib/i18n';
import { ClientProvider } from '@/lib/client';
import { Shell } from '@/components/shell';
export const metadata: Metadata = {
  title: 'Dreamwalk',
  description: 'Dreamwalk adventure platform',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('dreamwalk-theme');if(t==='system')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t==='light'?'light':'dark';}catch(e){}})();`,
          }}
        />
      </head>
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
