'use client';
import { EmailActionPage } from '@/components/account-email';
import { Suspense } from 'react';
import { usePathname } from 'next/navigation';
import { HomePage, ExplorePage, AdventurePage, CreatorPage } from '@/components/public';
import { AuthPage, AccountPage, OnboardingPage, Protected } from '@/components/account';
import { LibraryPage, HeroesPage, WalletPage, NotificationsPage } from '@/components/personal';
import { StudioPage } from '@/components/studio';
import { AdminPage } from '@/components/admin';
import { StaticPage } from '@/components/static';
import { Loading } from '@/components/ui';
import { useT } from '@/lib/i18n';
function Router() {
  const path = usePathname();
  const { locale } = useT();
  let content: React.ReactNode;
  if (path === '/' || path === '/home') content = <HomePage />;
  else if (path === '/explore') content = <ExplorePage />;
  else if (path.startsWith('/adventures/')) content = <AdventurePage slug={path.split('/')[2]} />;
  else if (path.startsWith('/creators/')) content = <CreatorPage handle={path.split('/')[2]} />;
  else if (path === '/auth/reset-password/confirm') content = <EmailActionPage action="reset" />;
  else if (path === '/auth/verify-email') content = <EmailActionPage action="verify" />;
  else if (path.startsWith('/auth/'))
    content = (
      <AuthPage signup={path === '/auth/sign-up'} reset={path === '/auth/reset-password'} />
    );
  else if (path === '/onboarding')
    content = (
      <Protected>
        <OnboardingPage />
      </Protected>
    );
  else if (path.startsWith('/account'))
    content = (
      <Protected>
        <AccountPage path={path} />
      </Protected>
    );
  else if (path === '/library')
    content = (
      <Protected>
        <LibraryPage />
      </Protected>
    );
  else if (path === '/my-characters')
    content = (
      <Protected>
        <HeroesPage />
      </Protected>
    );
  else if (path.startsWith('/studio'))
    content = (
      <Protected>
        <StudioPage path={path} />
      </Protected>
    );
  else if (path === '/wallet')
    content = (
      <Protected>
        <WalletPage />
      </Protected>
    );
  else if (path === '/notifications')
    content = (
      <Protected>
        <NotificationsPage />
      </Protected>
    );
  else if (path.startsWith('/admin'))
    content = (
      <Protected admin>
        <AdminPage path={path} />
      </Protected>
    );
  else content = <StaticPage path={path} />;
  return <div data-locale={locale}>{content}</div>;
}
export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Router />
    </Suspense>
  );
}
