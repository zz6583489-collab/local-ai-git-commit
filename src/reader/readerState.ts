import * as vscode from 'vscode';
import type { BookEncoding } from './txtParser';

const BOOKS_KEY = 'reader.books.v1';
const SETTINGS_KEY = 'reader.settings.v1';

export interface BookRecord {
  uri: string;
  title: string;
  encoding: BookEncoding;
  encodingMode?: 'auto' | BookEncoding;
  progress: number;
  version: string;
  lastOpened: number;
}

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  width: number;
}

function isRecord(value: unknown): value is BookRecord {
  if (!value || typeof value !== 'object') return false;
  const book = value as Partial<BookRecord>;
  return (
    typeof book.uri === 'string' &&
    typeof book.title === 'string' &&
    (book.encoding === 'utf8' || book.encoding === 'gb18030') &&
    (book.encodingMode === undefined ||
      book.encodingMode === 'auto' ||
      book.encodingMode === 'utf8' ||
      book.encodingMode === 'gb18030') &&
    typeof book.progress === 'number' &&
    Number.isFinite(book.progress) &&
    book.progress >= 0 &&
    typeof book.version === 'string' &&
    typeof book.lastOpened === 'number' &&
    Number.isFinite(book.lastOpened)
  );
}

export class BookStore {
  private books: BookRecord[];
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly state: vscode.Memento) {
    const saved = state.get<unknown>(BOOKS_KEY, []);
    this.books = Array.isArray(saved) ? saved.filter(isRecord) : [];
  }

  list(): BookRecord[] {
    return [...this.books].sort((a, b) => b.lastOpened - a.lastOpened);
  }

  get(uri: string): BookRecord | undefined {
    const book = this.books.find((item) => item.uri === uri);
    return book ? { ...book } : undefined;
  }

  save(book: BookRecord): Promise<void> {
    const index = this.books.findIndex((item) => item.uri === book.uri);
    if (index < 0) this.books.push({ ...book });
    else this.books[index] = { ...book };
    return this.persist();
  }

  remove(uri: string): Promise<void> {
    this.books = this.books.filter((item) => item.uri !== uri);
    return this.persist();
  }

  relocate(oldUri: string, book: BookRecord): Promise<void> {
    this.books = this.books.filter((item) => item.uri !== oldUri && item.uri !== book.uri);
    this.books.push({ ...book });
    return this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = this.books.map((book) => ({ ...book }));
    const write = (): Promise<void> => Promise.resolve(this.state.update(BOOKS_KEY, snapshot));
    this.pending = this.pending.then(write, write);
    return this.pending;
  }
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function readReaderSettings(state: vscode.Memento): ReaderSettings {
  const value = state.get<unknown>(SETTINGS_KEY, {});
  const saved = value && typeof value === 'object' ? (value as Partial<ReaderSettings>) : {};
  return {
    fontSize: bounded(saved.fontSize, 18, 12, 36),
    lineHeight: bounded(saved.lineHeight, 1.8, 1.2, 2.5),
    width: bounded(saved.width, 760, 480, 1200),
  };
}

export async function writeReaderSettings(
  state: vscode.Memento,
  settings: ReaderSettings,
): Promise<void> {
  const fontSize = bounded(settings.fontSize, 18, 12, 36);
  const lineHeight = bounded(settings.lineHeight, 1.8, 1.2, 2.5);
  const width = bounded(settings.width, 760, 480, 1200);
  await state.update(SETTINGS_KEY, { fontSize, lineHeight, width });
}
