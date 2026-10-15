"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface T { id: number; text: string; err: boolean }
const Ctx = createContext<(text: string, err?: boolean) => void>(() => {});
export const useToast = () => useContext(Ctx);

export default function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<T[]>([]);
  const push = useCallback((text: string, err = false) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-2), { id, text, err }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), err ? 7000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`toast${t.err ? " err" : ""}`} role={t.err ? "alert" : "status"}>
            <span>{t.text}</span>
            <button className="icon-btn" aria-label="Tutup" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))}>✕</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
