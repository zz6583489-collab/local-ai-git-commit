/* global acquireVsCodeApi, document, window, requestAnimationFrame */

(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const elements = {
    shell: document.getElementById('readerShell'),
    title: document.getElementById('title'),
    toc: document.getElementById('toc'),
    content: document.getElementById('content'),
    progress: document.getElementById('progress'),
    error: document.getElementById('error'),
    fontSize: document.getElementById('fontSize'),
    lineHeight: document.getElementById('lineHeight'),
    width: document.getElementById('width'),
    encoding: document.getElementById('encoding'),
    prevChapter: document.getElementById('prevChapter'),
    nextChapter: document.getElementById('nextChapter'),
    tocToggle: document.getElementById('tocToggle'),
  };

  if (Object.values(elements).some((element) => !element)) return;

  const stored = vscode.getState() || {};
  let chapters = [];
  let chunks = [];
  let totalLength = 0;
  let position = 0;
  let targetPosition = 0;
  let pendingNext = false;
  let pendingPrev = false;
  let lastSentPosition = -1;
  let scrollFrame = false;
  let restoring = false;
  let activeEncoding = 'utf8';
  let encodingChangePending = false;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function chapterIndexAt(offset) {
    let low = 0;
    let high = chapters.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (chapters[middle].start <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, low - 1);
  }

  function atBookEnd() {
    const last = chunks[chunks.length - 1];
    if (!last || last.end !== totalLength) return false;
    const remaining =
      elements.content.scrollHeight - elements.content.scrollTop - elements.content.clientHeight;
    return remaining <= 2;
  }

  function readThroughOffset() {
    if (atBookEnd()) return totalLength;
    const bottom = elements.content.getBoundingClientRect().bottom - 12;
    const paragraphs = elements.content.querySelectorAll('.reader-paragraph');
    for (let index = paragraphs.length - 1; index >= 0; index--) {
      const paragraph = paragraphs[index];
      const rectangle = paragraph.getBoundingClientRect();
      if (rectangle.top > bottom) continue;
      const start = Number(paragraph.dataset.offset);
      const end = Number(paragraph.dataset.end);
      if (rectangle.bottom <= bottom) return Math.max(position, end);
      const textNode = paragraph.firstChild;
      if (!textNode || textNode.nodeType !== 3 || !textNode.length) return position;
      const range = document.createRange();
      let low = 0;
      let high = textNode.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        range.setStart(textNode, middle - 1);
        range.setEnd(textNode, middle);
        if (range.getBoundingClientRect().bottom <= bottom) low = middle;
        else high = middle - 1;
      }
      return Math.max(position, Math.min(end, start + low));
    }
    return position;
  }

  function updateProgress() {
    const readThrough = clamp(readThroughOffset(), 0, totalLength);
    const bookPercent = totalLength ? ((readThrough / totalLength) * 100).toFixed(1) : '0.0';
    const chapterIndex = chapterIndexAt(position);
    const chapter = chapters[chapterIndex];
    const chapterLength = chapter ? chapter.end - chapter.start : 0;
    const chapterPercent = chapterLength
      ? (
          ((clamp(readThrough, chapter.start, chapter.end) - chapter.start) / chapterLength) *
          100
        ).toFixed(1)
      : '0.0';
    elements.progress.textContent = chapter
      ? `${chapter.title} · ${chapterPercent}%`
      : `${bookPercent}%`;
    elements.progress.title = chapter
      ? `本章 ${chapterPercent}% · 全书 ${bookPercent}%`
      : `全书 ${bookPercent}%`;

    for (const item of elements.toc.querySelectorAll('.reader-toc-item')) {
      const active = Number(item.dataset.index) === chapterIndex;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'location');
      else item.removeAttribute('aria-current');
    }
    elements.prevChapter.disabled = !chapters.length || chapterIndex <= 0;
    elements.nextChapter.disabled = !chapters.length || chapterIndex >= chapters.length - 1;
  }

  function setPosition(nextPosition, notify) {
    position = clamp(Math.trunc(nextPosition), 0, totalLength);
    vscode.setState({ ...stored, position });
    updateProgress();
    if (notify && position !== lastSentPosition) {
      lastSentPosition = position;
      vscode.postMessage({ type: 'position', offset: position });
    }
  }

  function setError(message) {
    elements.error.textContent = message;
    elements.error.hidden = !message;
  }

  function applySettings(settings) {
    const fontSize = clamp(Number(settings.fontSize) || 18, 12, 36);
    const lineHeight = clamp(Number(settings.lineHeight) || 1.8, 1.2, 2.5);
    const width = clamp(Number(settings.width) || 760, 480, 1200);
    elements.fontSize.value = String(fontSize);
    elements.lineHeight.value = String(lineHeight);
    elements.width.value = String(width);
    elements.content.style.setProperty('--reader-font-size', `${fontSize}px`);
    elements.content.style.setProperty('--reader-line-height', String(lineHeight));
    elements.content.style.setProperty('--reader-width', `${width}px`);
  }

  function buildToc() {
    elements.toc.replaceChildren();
    const heading = document.createElement('h2');
    heading.className = 'reader-toc-heading';
    heading.textContent = '目录';
    elements.toc.append(heading);
    chapters.forEach((chapter, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'reader-toc-item';
      button.dataset.index = String(index);
      button.textContent = chapter.title;
      button.title = chapter.title;
      button.addEventListener('click', () => navigate(chapter.start));
      elements.toc.append(button);
    });
    updateProgress();
  }

  function renderChunk(start, end, content) {
    const chunk = document.createElement('section');
    chunk.className = 'reader-chunk';
    chunk.dataset.start = String(start);
    chunk.dataset.end = String(end);
    let offset = start;
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      if (index === lines.length - 1 && !line && content.endsWith('\n')) return;
      const paragraph = document.createElement('p');
      paragraph.className = 'reader-paragraph';
      paragraph.dataset.offset = String(offset);
      paragraph.dataset.end = String(offset + line.length + (index < lines.length - 1 ? 1 : 0));
      paragraph.textContent = line || '\u00a0';
      chunk.append(paragraph);
      offset += line.length + (index < lines.length - 1 ? 1 : 0);
    });
    return chunk;
  }

  function scrollToOffset(offset) {
    const paragraphs = elements.content.querySelectorAll('.reader-paragraph');
    let target = paragraphs[0];
    for (const paragraph of paragraphs) {
      if (Number(paragraph.dataset.offset) > offset) break;
      target = paragraph;
    }
    if (!target) return;
    const textNode = target.firstChild;
    let targetRect = target.getBoundingClientRect();
    if (textNode && textNode.nodeType === 3 && textNode.length) {
      const character = clamp(offset - Number(target.dataset.offset), 0, textNode.length - 1);
      const range = document.createRange();
      range.setStart(textNode, character);
      range.setEnd(textNode, character + 1);
      targetRect = range.getBoundingClientRect();
    }
    const delta = targetRect.top - elements.content.getBoundingClientRect().top;
    elements.content.scrollTop += delta - 24;
  }

  function trimChunks(from) {
    while (chunks.length > 5) {
      if (from === 'next') {
        const removed = chunks.shift();
        const height = removed.element.getBoundingClientRect().height;
        removed.element.remove();
        elements.content.scrollTop -= height;
      } else {
        const removed = chunks.pop();
        removed.element.remove();
      }
    }
  }

  function addContent(message) {
    const start = Number(message.start);
    const end = Number(message.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return;
    if (typeof message.text !== 'string' || message.text.length !== end - start) return;
    const element = renderChunk(start, end, message.text);

    if (message.reset || !chunks.length) {
      restoring = true;
      elements.content.replaceChildren(element);
      chunks = [{ start, end, element }];
      pendingNext = false;
      pendingPrev = false;
      requestAnimationFrame(() => {
        scrollToOffset(targetPosition);
        restoring = false;
        updateProgress();
        maybeLoad();
      });
      return;
    }

    const first = chunks[0];
    const last = chunks[chunks.length - 1];
    if (start === last.end && end > start) {
      elements.content.append(element);
      chunks.push({ start, end, element });
      pendingNext = false;
      trimChunks('next');
    } else if (end === first.start && end > start) {
      const oldHeight = elements.content.scrollHeight;
      elements.content.prepend(element);
      chunks.unshift({ start, end, element });
      elements.content.scrollTop += elements.content.scrollHeight - oldHeight;
      pendingPrev = false;
      trimChunks('prev');
    } else {
      pendingNext = false;
      pendingPrev = false;
      return;
    }
    updateProgress();
    maybeLoad();
  }

  function firstVisibleOffset() {
    const top = elements.content.getBoundingClientRect().top + 20;
    let first = null;
    for (const paragraph of elements.content.querySelectorAll('.reader-paragraph')) {
      if (paragraph.getBoundingClientRect().bottom >= top) {
        first = paragraph;
        break;
      }
    }
    if (!first) return position;
    const paragraphStart = Number(first.dataset.offset);
    const textNode = first.firstChild;
    if (!textNode || textNode.nodeType !== 3 || textNode.length < 2) return paragraphStart;
    const range = document.createRange();
    let low = 0;
    let high = textNode.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      range.setStart(textNode, middle);
      range.setEnd(textNode, middle + 1);
      if (range.getBoundingClientRect().bottom >= top) high = middle;
      else low = middle + 1;
    }
    return paragraphStart + low;
  }

  function maybeLoad() {
    if (!chunks.length || restoring) return;
    const first = chunks[0];
    const last = chunks[chunks.length - 1];
    const remaining =
      elements.content.scrollHeight - elements.content.scrollTop - elements.content.clientHeight;
    if (remaining < 800 && last.end < totalLength && !pendingNext) {
      pendingNext = true;
      vscode.postMessage({ type: 'load', direction: 'next', offset: last.end });
    }
    if (elements.content.scrollTop < 500 && first.start > 0 && !pendingPrev) {
      pendingPrev = true;
      vscode.postMessage({ type: 'load', direction: 'prev', offset: first.start });
    }
  }

  function navigate(offset) {
    targetPosition = clamp(Math.trunc(offset), 0, totalLength);
    setPosition(targetPosition, true);
    vscode.postMessage({ type: 'navigate', offset: targetPosition });
  }

  function navigateChapter(direction) {
    if (!chapters.length) return;
    const index = chapterIndexAt(position) + direction;
    if (index >= 0 && index < chapters.length) navigate(chapters[index].start);
  }

  function updateReaderSettings() {
    const anchor = chunks.length ? firstVisibleOffset() : position;
    const settings = {
      fontSize: Number(elements.fontSize.value),
      lineHeight: Number(elements.lineHeight.value),
      width: Number(elements.width.value),
    };
    applySettings(settings);
    requestAnimationFrame(() => {
      if (chunks.length) scrollToOffset(anchor);
      setPosition(anchor, true);
    });
    vscode.postMessage({ type: 'settings', settings });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'init') {
      elements.content.replaceChildren();
      chunks = [];
      pendingNext = false;
      pendingPrev = false;
      chapters = Array.isArray(message.chapters)
        ? message.chapters.filter(
            (chapter) =>
              chapter &&
              typeof chapter.title === 'string' &&
              Number.isInteger(chapter.start) &&
              Number.isInteger(chapter.end),
          )
        : [];
      totalLength = Math.max(0, Number(message.totalLength) || 0);
      targetPosition = clamp(Number(message.position) || 0, 0, totalLength);
      position = targetPosition;
      lastSentPosition = position;
      elements.title.textContent = String(message.title || '小说阅读器');
      activeEncoding = ['auto', 'utf8', 'gb18030'].includes(message.encoding)
        ? message.encoding
        : 'auto';
      encodingChangePending = false;
      elements.encoding.value = activeEncoding;
      applySettings(message.settings || {});
      buildToc();
      setError('');
      vscode.setState({ ...stored, position });
    } else if (message.type === 'content') {
      addContent(message);
    } else if (message.type === 'error') {
      setError(String(message.message || '读取失败'));
      pendingNext = false;
      pendingPrev = false;
      if (encodingChangePending) {
        elements.encoding.value = activeEncoding;
        encodingChangePending = false;
      }
    }
  });

  elements.content.addEventListener(
    'scroll',
    () => {
      if (scrollFrame) return;
      scrollFrame = true;
      requestAnimationFrame(() => {
        scrollFrame = false;
        if (!restoring && chunks.length) setPosition(firstVisibleOffset(), true);
        maybeLoad();
      });
    },
    { passive: true },
  );
  elements.content.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      navigateChapter(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      navigateChapter(-1);
    }
  });
  elements.prevChapter.addEventListener('click', () => navigateChapter(-1));
  elements.nextChapter.addEventListener('click', () => navigateChapter(1));
  elements.tocToggle.addEventListener('click', () => {
    const collapsed = elements.shell.classList.toggle('toc-collapsed');
    elements.tocToggle.setAttribute('aria-expanded', String(!collapsed));
    elements.toc.setAttribute('aria-hidden', String(collapsed));
  });
  for (const input of [elements.fontSize, elements.lineHeight, elements.width]) {
    input.addEventListener('change', updateReaderSettings);
  }
  elements.encoding.addEventListener('change', () => {
    encodingChangePending = true;
    vscode.postMessage({ type: 'encoding', encoding: elements.encoding.value });
  });

  const flushPosition = () => {
    if (chunks.length) setPosition(firstVisibleOffset(), true);
  };
  window.addEventListener('pagehide', flushPosition);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPosition();
  });

  if (window.innerWidth < 780) elements.shell.classList.add('toc-collapsed');
  elements.tocToggle.setAttribute(
    'aria-expanded',
    String(!elements.shell.classList.contains('toc-collapsed')),
  );
  elements.toc.setAttribute(
    'aria-hidden',
    String(elements.shell.classList.contains('toc-collapsed')),
  );
  vscode.postMessage({ type: 'ready', position: stored.position });
})();
