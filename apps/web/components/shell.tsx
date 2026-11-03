'use client';
import './shell.css';
import { AuthMark } from './auth-mark';
import { DreamsBalance, useDreamsText } from './dreams-wallet';
import { SparksBalance } from './sparks-balance';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import {
  BookOpen,
  Wrench,
  ChevronRight,
  ArrowLeft,
  MoonStar,
  House,
  Library,
  UsersRound,
  Feather,
  Sparkles,
  Settings,
  CircleHelp,
  ShieldCheck,
  Bell,
  Menu,
  X,
  Sun,
  Moon,
  LogOut,
  ArrowUpRight,
  Search,
} from 'lucide-react';
import { api, assetUrl, useClient, type User } from '@/lib/client';
const nav = [
  { href: '/home', label: 'Главная', icon: House },
  { href: '/explore', label: 'Открыть миры', icon: BookOpen },
  { href: '/library', label: 'Моя библиотека', icon: Library },
  { href: '/my-characters', label: 'Мои герои', icon: UsersRound },
];
export function Shell({ children }: { children: React.ReactNode }) {
  const { t: tr, locale } = useT();
  const { text: dreamsText } = useDreamsText();
  const path = usePathname(),
    router = useRouter(),
    { user, setUser, toast } = useClient();
  const inAuth = path.startsWith('/auth/');
  const inGame = /^\/game\/[^/]+$/.test(path);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => setMenu(false), [path]);
  useEffect(() => {
    const desktop = matchMedia('(min-width: 901px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setMenu(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const sidebar = document.getElementById('main-sidebar');
    const focusable = () =>
      Array.from(
        sidebar?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    sidebar?.querySelector<HTMLButtonElement>('.mobile-close')?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false);
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [menu]);
  const active = (href: string) =>
    path === href ||
    (href === '/home' && path === '/') ||
    (href !== '/home' && path.startsWith(`${href}/`));
  return (
    <div
      className={`app-shell ${inGame ? 'game-shell' : ''} ${inAuth ? 'auth-shell' : ''}`}
      data-surface={inGame ? 'game' : path.split('/')[1] || 'home'}
    >
      <a className="skip-link" href="#main-content">
        {tr('К содержимому')}
      </a>
      {!inGame && !inAuth && (
        <aside id="main-sidebar" className={`sidebar ${menu ? 'open' : ''}`}>
          <Link href="/" className="brand" onClick={() => setMenu(false)}>
            <span className="brand-mark" aria-hidden="true">
              <AuthMark />
            </span>
            <span>Dreamwalk</span>
          </Link>
          <button
            className="icon-button mobile-close"
            aria-label={tr('Закрыть меню')}
            onClick={() => setMenu(false)}
          >
            <X />
          </button>
          <nav>
            {nav.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={`nav-item ${active(href) ? 'active' : ''}`}
                aria-current={active(href) ? 'page' : undefined}
                onClick={() => setMenu(false)}
              >
                <Icon size={24} />
                {href === '/explore'
                  ? { ru: 'Истории', uk: 'Історії', en: 'Stories' }[locale]
                  : tr(label)}
              </Link>
            ))}
          </nav>
          <nav>
            <Link
              className={`nav-item ${path.startsWith('/studio') && !active('/studio/visuals') ? 'active' : ''}`}
              href="/studio"
              onClick={() => setMenu(false)}
            >
              <Sparkles size={24} />
              {tr('Студия')}
            </Link>
            <Link
              className={`nav-item ${active('/studio/visuals') ? 'active' : ''}`}
              href="/studio/visuals"
              onClick={() => setMenu(false)}
            >
              <Wrench size={24} />
              {{ ru: 'Мастерская', uk: 'Майстерня', en: 'Workshop' }[locale]}
            </Link>
            <Link
              className={`nav-item ${active('/wallet') ? 'active' : ''}`}
              href="/wallet"
              onClick={() => setMenu(false)}
            >
              <Sparkles size={24} />
              {dreamsText.title}
            </Link>
            {user?.role === 'admin' && (
              <Link
                className={`nav-item ${path.startsWith('/admin') ? 'active' : ''}`}
                href="/admin"
                onClick={() => setMenu(false)}
              >
                <ShieldCheck size={24} />
                {tr('Управление')}
              </Link>
            )}
          </nav>
          <form
            className="top-search rail-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              setMenu(false);
              router.push(`/explore?q=${encodeURIComponent(query)}`);
            }}
          >
            <Search size={17} />
            <input
              aria-label={tr('Поиск миров')}
              placeholder={tr('Найти своё следующее приключение')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="icon-button" type="submit" aria-label={tr('Поиск миров')}>
              <ChevronRight size={18} />
            </button>
          </form>
          <div className="sidebar-bottom">
            <Link className="nav-item" href="/account/settings" onClick={() => setMenu(false)}>
              <Settings size={18} />
              {tr('Настройки')}
            </Link>
            <Link className="nav-item" href="/help" onClick={() => setMenu(false)}>
              <CircleHelp size={18} />
              {tr('Помощь и поддержка')}
            </Link>
            {user && (
              <Link
                className={`nav-item rail-profile ${active('/account/profile') ? 'active' : ''}`}
                href="/account/profile"
                onClick={() => setMenu(false)}
              >
                <span className="avatar">
                  {user.avatarAssetId ? (
                    <img src={assetUrl(user.avatarAssetId)} alt="" />
                  ) : (
                    user.handle.slice(0, 1)
                  )}
                </span>
                <span>{tr('Профиль')}</span>
                <ChevronRight size={18} />
              </Link>
            )}
            <div className="rail-preferences">
              <ShellPreferences />
            </div>
          </div>
        </aside>
      )}
      {!inGame && !inAuth && menu && (
        <button
          aria-label={tr('Закрыть меню')}
          className="menu-backdrop"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="workspace">
        <header className="topbar">
          {!inGame && !inAuth && (
            <button
              className="icon-button mobile-menu"
              aria-label={tr('Открыть меню')}
              aria-expanded={menu}
              aria-controls="main-sidebar"
              onClick={() => setMenu(true)}
            >
              <Menu />
            </button>
          )}
          {inAuth ? (
            <Link href="/" className="auth-brand">
              <MoonStar size={30} aria-hidden="true" />
              Dreamwalk
            </Link>
          ) : inGame ? (
            <div id="game-toolbar" className="game-toolbar-slot">
              <Link href="/game" className="game-return">
                <ArrowLeft size={18} />
                {tr('К кампаниям')}
              </Link>
            </div>
          ) : null}
          <div className="top-actions">
            {(inAuth || inGame) && <ShellPreferences />}
            {!inAuth &&
              (user ? (
                <>
                  <Link href="/wallet" className="wallet-chip">
                    <Sparkles size={15} />
                    <span>{tr('Искры')}</span>
                    <SparksBalance key={user.id} ownerId={user.id} />
                    <span className="currency-divider" aria-hidden="true">
                      ·
                    </span>
                    <MoonStar size={15} aria-hidden="true" />
                    <span className="wallet-currency-name">{dreamsText.name}</span>
                    <DreamsBalance key={`dreams-${user.id}`} ownerId={user.id} />
                  </Link>
                  <Link
                    href="/notifications"
                    className="icon-button"
                    aria-label={tr('Уведомления')}
                  >
                    <Bell size={24} />
                  </Link>
                  <Link href="/account/profile" className="profile-chip" aria-label={tr('Профиль')}>
                    <span className="avatar">
                      {user.avatarAssetId ? (
                        <img src={assetUrl(user.avatarAssetId)} alt="" />
                      ) : (
                        user.handle.slice(0, 1)
                      )}
                    </span>
                    <span>{user.handle}</span>
                  </Link>
                  <button
                    className="icon-button logout"
                    aria-label={tr('Выйти')}
                    onClick={async () => {
                      await api('/auth/logout', { method: 'POST', body: '{}' });
                      setUser(null);
                      router.push('/');
                      toast(tr('Вы вышли из аккаунта'));
                    }}
                  >
                    <LogOut size={17} />
                  </button>
                </>
              ) : (
                <>
                  <Link className="login-link" href="/auth/sign-in">
                    {tr('Войти')}
                  </Link>
                  <Link className="button primary compact" href="/auth/sign-up">
                    {tr('Начать историю')}
                    <ArrowUpRight size={15} />
                  </Link>
                </>
              ))}
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="main-content">
          {children}
        </main>
        <footer className="main-footer">
          <span>{tr('© Dreamwalk · Миры, в которые хочется вернуться')}</span>
          <div>
            <Link href="/about">{tr('О проекте')}</Link>
            <Link href="/content-policy">{tr('Правила')}</Link>
            <Link href="/privacy">{tr('Приватность')}</Link>
          </div>
        </footer>
      </div>
      {!inGame && !inAuth && (
        <nav className="bottom-nav" aria-label={tr('Мобильная навигация')}>
          {nav.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={active(href) ? 'active' : ''}>
              <Icon size={20} />
              <span>
                {href === '/library'
                  ? tr('Библиотека')
                  : href === '/explore'
                    ? tr('Миры')
                    : tr(label)}
              </span>
            </Link>
          ))}
          <Link href="/studio" className={path.startsWith('/studio') ? 'active' : ''}>
            <Feather size={20} />
            <span>{tr('Студия')}</span>
          </Link>
        </nav>
      )}
    </div>
  );
}

function ShellPreferences() {
  const { t: tr, locale, setLocale } = useT();
  const { user, setUser, toast } = useClient();
  return (
    <>
      {' '}
      <select
        className="locale-select"
        aria-label={tr('Язык интерфейса')}
        value={locale}
        onChange={(e) => setLocale(e.target.value as 'ru' | 'en' | 'uk')}
      >
        <option value="ru">RU</option>
        <option value="uk">UK</option>
        <option value="en">EN</option>
      </select>
      <button
        className="icon-button theme-button"
        aria-label={tr('Переключить тему')}
        onClick={() => {
          const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
          document.documentElement.dataset.theme = theme;
          localStorage.setItem('dreamwalk-theme', theme);
          if (user)
            void api<User>('/account/settings', {
              method: 'PATCH',
              body: JSON.stringify({ theme }),
            })
              .then(setUser)
              .catch(() => toast(tr('Тема изменена на этом устройстве.')));
        }}
      >
        <Sun size={18} />
        <Moon size={18} />
      </button>
    </>
  );
}
