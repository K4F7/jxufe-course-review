import { afterEach, describe, expect, it } from "vitest";
import {
  readReviewAdminChromeVisible,
  resolveCommentDeleteVisible,
  resolveReviewAdminChromeVisible,
  resolveReviewAdminDockVisible,
  REVIEW_ADMIN_CHROME_STORAGE_KEY,
  writeReviewAdminChromeVisible,
} from "../src/lib/review-admin-chrome";

describe("review admin chrome preference", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };

  afterEach(() => store.clear());

  it("defaults off and persists the dock switch in session storage", () => {
    expect(readReviewAdminChromeVisible(storage)).toBe(false);
    expect(resolveReviewAdminChromeVisible({ storedOn: false })).toBe(false);

    writeReviewAdminChromeVisible(storage, true);
    expect(storage.getItem(REVIEW_ADMIN_CHROME_STORAGE_KEY)).toBe("1");
    expect(readReviewAdminChromeVisible(storage)).toBe(true);
    expect(resolveReviewAdminChromeVisible({ storedOn: true })).toBe(true);

    writeReviewAdminChromeVisible(storage, false);
    expect(storage.getItem(REVIEW_ADMIN_CHROME_STORAGE_KEY)).toBeNull();
    expect(readReviewAdminChromeVisible(storage)).toBe(false);
  });

  it("never shows the dock to non-admins unless preview=admin", () => {
    expect(
      resolveReviewAdminDockVisible({ adminAuthed: false, preview: null }),
    ).toBe(false);
    expect(
      resolveReviewAdminDockVisible({
        adminAuthed: false,
        preview: "review-comments",
      }),
    ).toBe(false);
    expect(
      resolveReviewAdminDockVisible({ adminAuthed: true, preview: null }),
    ).toBe(true);
    expect(
      resolveReviewAdminDockVisible({ adminAuthed: false, preview: "admin" }),
    ).toBe(true);
  });

  it("hides preview viewerOwned comment delete until the dock switch is on", () => {
    expect(
      resolveCommentDeleteVisible({
        showAdminControls: false,
        viewerPublicCode: null,
        authorPublicCode: 1,
        viewerOwned: true,
      }),
    ).toBe(false);
    expect(
      resolveCommentDeleteVisible({
        showAdminControls: true,
        viewerPublicCode: null,
        authorPublicCode: 1,
        viewerOwned: true,
      }),
    ).toBe(true);
    expect(
      resolveCommentDeleteVisible({
        showAdminControls: false,
        viewerPublicCode: 9,
        authorPublicCode: 1,
        viewerOwned: true,
      }),
    ).toBe(false);
  });

  it("keeps an author's own comment delete without the dock switch", () => {
    expect(
      resolveCommentDeleteVisible({
        showAdminControls: false,
        viewerPublicCode: 1,
        authorPublicCode: 1,
      }),
    ).toBe(true);
    expect(
      resolveCommentDeleteVisible({
        showAdminControls: false,
        viewerPublicCode: 2,
        authorPublicCode: 1,
      }),
    ).toBe(false);
  });
});
