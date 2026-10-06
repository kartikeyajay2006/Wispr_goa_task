import {flushSync} from 'react-dom';
import {Moon, Sun} from 'lucide-react';
import {useTheme, type Theme} from '../theme';
import {prefersReducedMotion} from './motion';

type ViewTransitionDocument = Document & {startViewTransition?: (update: () => void) => {ready: Promise<void>}};

/** Switches between Onyx and Vellum; the new paper spreads from the button as a circle. */
export function ThemeToggle() {
  const {theme, setTheme} = useTheme();
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    const doc = document as ViewTransitionDocument;
    if (!doc.startViewTransition || prefersReducedMotion()) { setTheme(next); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const transition = doc.startViewTransition(() => { flushSync(() => setTheme(next)); });
    void transition.ready.then(() => document.documentElement.animate(
      {clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]},
      {duration: 700, easing: 'cubic-bezier(0.7, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)'},
    ));
  };
  return <button type="button" className="theme-toggle" onClick={toggle} aria-label={`Switch to ${next === 'light' ? 'cream' : 'onyx'} theme`} title={next === 'light' ? 'Vellum (cream and gold)' : 'Onyx (dark)'}>
    <span className={`theme-toggle-track ${theme}`}><span className="theme-toggle-thumb">{theme === 'dark' ? <Moon size={13} /> : <Sun size={13} />}</span></span>
  </button>;
}
