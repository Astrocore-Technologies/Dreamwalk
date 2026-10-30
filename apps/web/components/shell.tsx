'use client';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import {
  Compass,
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
  { href: '/explore', label: 'Открыть миры', icon: Compass },
  { href: '/library', label: 'Моя библиотека', icon: Library },
  { href: '/my-characters', label: 'Мои герои', icon: UsersRound },
];
export function Shell({ children }: { children: React.ReactNode }) {
  const { t: tr } = useT();
  const { locale, setLocale } = useT();
  const path = usePathname(),
    router = useRouter(),
    { user, setUser, toast } = useClient();
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!menu) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false);
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [menu]);
  const active = (href: string) => path === href || (href === '/home' && path === '/');
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {tr('К содержимому')}
      </a>
      <aside id="main-sidebar" className={`sidebar ${menu ? 'open' : ''}`}>
        <Link href="/" className="brand" onClick={() => setMenu(false)}>
          <span className="brand-mark">✧</span>
          <span>
            dreamwalk<span className="brand-dot">.</span>
          </span>
        </Link>
        <button
          className="icon-button mobile-close"
          aria-label={tr('Закрыть меню')}
          onClick={() => setMenu(false)}
        >
          <X />
        </button>
        <span className="nav-caption">{tr('ТВОЁ ПРИКЛЮЧЕНИЕ')}</span>
        <nav>
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`nav-item ${active(href) ? 'active' : ''}`}
              onClick={() => setMenu(false)}
            >
              <Icon size={19} />
              {tr(label)}
              {active(href) && <span className="nav-dot" />}
            </Link>
          ))}
        </nav>
        <div className="nav-divider" />
        <span className="nav-caption">{tr('СОЗДАВАЙ БОЛЬШЕ')}</span>
        <nav>
          <Link
            className={`nav-item ${path.startsWith('/studio') ? 'active' : ''}`}
            href="/studio"
            onClick={() => setMenu(false)}
          >
            <Feather size={19} />
            {tr('Студия автора')}
            <span className="mini-tag">{tr('NEW')}</span>
          </Link>
          <Link
            className={`nav-item ${active('/wallet') ? 'active' : ''}`}
            href="/wallet"
            onClick={() => setMenu(false)}
          >
            <Sparkles size={19} />
            {tr('Мои искры')}
          </Link>
          {user?.role === 'admin' && (
            <Link
              className={`nav-item ${path.startsWith('/admin') ? 'active' : ''}`}
              href="/admin"
              onClick={() => setMenu(false)}
            >
              <ShieldCheck size={19} />
              {tr('Управление')}
            </Link>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="studio-promo">
            <span className="little-star">✦</span>
            <strong>
              {tr('У каждого мира')}
              <br />
              {tr('есть автор.')}
            </strong>
            <p>{tr('Каким будет твой?')}</p>
            <Link href="/studio/adventures/new" onClick={() => setMenu(false)}>
              {tr('Создать историю')}
              <ArrowUpRight size={15} />
            </Link>
          </div>
          <Link className="nav-item" href="/account/settings" onClick={() => setMenu(false)}>
            <Settings size={18} />
            {tr('Настройки')}
          </Link>
          <Link className="nav-item" href="/help" onClick={() => setMenu(false)}>
            <CircleHelp size={18} />
            {tr('Помощь и поддержка')}
          </Link>
          <div className="sidebar-footer">
            <span className="online-dot" />
            {tr('Платформа · ранний доступ')}
          </div>
        </div>
      </aside>
      {menu && (
        <button
          aria-label={tr('Закрыть меню')}
          className="menu-backdrop"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="workspace">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label={tr('Открыть меню')}
            aria-expanded={menu}
            aria-controls="main-sidebar"
            onClick={() => setMenu(true)}
          >
            <Menu />
          </button>
          {path === '/explore' ? (
            <span className="catalog-shell-label">{tr('Открыть миры')}</span>
          ) : (
            <form
              className="top-search"
              onSubmit={(e) => {
                e.preventDefault();
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
              <kbd>⌕</kbd>
            </form>
          )}
          <div className="top-actions">
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
            {user ? (
              <>
                <Link href="/wallet" className="wallet-chip">
                  <Sparkles size={15} />
                  <span>{tr('Искры')}</span>
                  <small>DEMO</small>
                </Link>
                <Link href="/notifications" className="icon-button" aria-label={tr('Уведомления')}>
                  <Bell size={19} />
                </Link>
                <Link href="/account/profile" className="profile-chip">
                  <span className="avatar">
                    {user.avatarAssetId ? (
                      <img src={assetUrl(user.avatarAssetId)} alt="" />
                    ) : (
                      user.name.slice(0, 1)
                    )}
                  </span>
                  <span>{user.name}</span>
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
            )}
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
    </div>
  );
}
