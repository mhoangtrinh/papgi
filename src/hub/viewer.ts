// Full-size look at pages before running a tool: one column of big pages,
// loaded as they scroll into view. Read-only; closes with Esc / ✕ / back.
import { icon } from "../ui/icons";

export interface ViewPage {
  /** Extra turn in degrees (0/90/180/270). */
  rotate: number;
  /** Shown in the header, e.g. "B · page 2". */
  label: string;
  /** Colour of the file (the stripe on top of the page). */
  color?: string;
  /** Small picture that is already there (gives the page shape before loading). */
  thumb?: string;
  /** Big picture: an image URL. */
  load(): Promise<string>;
}

export function openViewer(
  pages: ViewPage[],
  start: number,
  title: string,
  onClose?: () => void,
): void {
  if (!pages.length) return;
  document.querySelector(".pviewer")?.remove();
  const el = document.createElement("div");
  el.className = "pviewer";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", title);
  el.innerHTML = `
    <header class="pv-bar">
      <b class="pv-title"></b>
      <span class="pv-where muted"></span>
      <span class="pv-sp"></span>
      <button class="icon-btn" data-pv="prev" title="Previous page (↑)">${icon("up")}</button>
      <button class="icon-btn" data-pv="next" title="Next page (↓)">${icon("down")}</button>
      <button class="icon-btn" data-pv="close" title="Close (Esc)">${icon("close")}</button>
    </header>
    <div class="pv-scroll"><div class="pv-pages"></div></div>`;
  el.querySelector(".pv-title")!.textContent = title;
  const scroll = el.querySelector<HTMLElement>(".pv-scroll")!;
  const list = el.querySelector<HTMLElement>(".pv-pages")!;
  const where = el.querySelector<HTMLElement>(".pv-where")!;

  const boxes = pages.map((p, i) => {
    const box = document.createElement("div");
    box.className = "pv-page";
    box.dataset.i = String(i);
    if (p.color) box.style.setProperty("--file", p.color);
    box.style.setProperty("--ar", p.rotate % 180 ? "1.414" : "0.707");
    box.innerHTML = `<div class="pv-sheet"></div><div class="pv-cap muted small">${i + 1} · ${esc(p.label)}</div>`;
    list.append(box);
    return box;
  });

  /** Page shape from its picture (natural size), turned as asked. */
  const shape = (box: HTMLElement, w: number, h: number, rotate: number) => {
    const turned = rotate % 180 !== 0;
    box.style.setProperty("--ar", String(turned ? h / w : w / h));
    box.style.setProperty("--iw", turned ? `${(w / h) * 100}%` : "100%");
  };

  // shapes from the small pictures first, so the column doesn't jump while big pages load
  const shapes = pages.map((p, i) =>
    p.thumb
      ? new Promise<void>((done) => {
          const im = new Image();
          im.onload = () => (
            shape(boxes[i], im.naturalWidth, im.naturalHeight, p.rotate),
            done()
          );
          im.onerror = () => done();
          im.src = p.thumb!;
        })
      : Promise.resolve(),
  );

  // big pictures, one at a time, nearest first
  const wanted = new Set<number>();
  const loaded = new Set<number>();
  let loading = false;
  let current = start;
  const pump = async () => {
    if (loading) return;
    loading = true;
    while (wanted.size && el.isConnected) {
      const i = [...wanted].sort(
        (a, b) => Math.abs(a - current) - Math.abs(b - current),
      )[0];
      wanted.delete(i);
      if (loaded.has(i)) continue;
      loaded.add(i);
      try {
        const url = await pages[i].load();
        if (!el.isConnected) break;
        const img = new Image();
        img.alt = `Page ${i + 1}`;
        img.draggable = false;
        img.src = url;
        await img.decode().catch(() => {});
        shape(
          boxes[i],
          img.naturalWidth || 1,
          img.naturalHeight || 1,
          pages[i].rotate,
        );
        img.style.transform = `translate(-50%, -50%) rotate(${pages[i].rotate}deg)`;
        const sheet = boxes[i].querySelector(".pv-sheet")!;
        sheet.replaceChildren(img);
        sheet.classList.add("ready");
      } catch {
        boxes[i].querySelector(".pv-sheet")!.classList.add("failed");
      }
    }
    loading = false;
  };
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.i);
        if (e.isIntersecting) wanted.add(i);
        else wanted.delete(i);
      }
      void pump();
    },
    { root: scroll, rootMargin: "800px 0px" },
  );

  const update = () => {
    const mid = scroll.scrollTop + scroll.clientHeight / 2;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].offsetTop <= mid) best = i;
      else break;
    }
    current = best;
    where.textContent = `Page ${best + 1} of ${pages.length} · ${pages[best].label}`;
  };
  const go = (i: number, smooth = true) => {
    i = Math.max(0, Math.min(pages.length - 1, i));
    scroll.scrollTo({
      top: boxes[i].offsetTop - 12,
      behavior: smooth ? "smooth" : "auto",
    });
    current = i;
    where.textContent = `Page ${i + 1} of ${pages.length} · ${pages[i].label}`;
  };

  const close = () => {
    seen.disconnect();
    el.remove();
    removeEventListener("keydown", onKey, true);
    removeEventListener("popstate", onPop);
    if (history.state?.pviewer) history.back();
    prevFocus?.focus();
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (
      e.key === "ArrowDown" ||
      e.key === "ArrowRight" ||
      e.key === "PageDown" ||
      (e.key === " " && !e.shiftKey)
    )
      go(current + 1);
    else if (
      e.key === "ArrowUp" ||
      e.key === "ArrowLeft" ||
      e.key === "PageUp" ||
      (e.key === " " && e.shiftKey)
    )
      go(current - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(pages.length - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // (the phone's back gesture closes the viewer instead of leaving the tool)
  const onPop = () => {
    if (el.isConnected) {
      history.replaceState(null, "");
      close();
    }
  };
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pv]");
    if (b?.dataset.pv === "close") close();
    else if (b?.dataset.pv === "prev") go(current - 1);
    else if (b?.dataset.pv === "next") go(current + 1);
    else if (e.target === scroll) close();
  });
  scroll.addEventListener("scroll", update, { passive: true });

  const prevFocus = document.activeElement as HTMLElement | null;
  document.body.append(el);
  history.pushState({ pviewer: true }, "", location.href);
  addEventListener("keydown", onKey, true);
  addEventListener("popstate", onPop);
  el.querySelector<HTMLElement>('[data-pv="close"]')!.focus();
  void Promise.race([
    Promise.all(shapes),
    new Promise((r) => setTimeout(r, 400)),
  ]).then(() => {
    go(start, false);
    boxes.forEach((b) => seen.observe(b));
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
