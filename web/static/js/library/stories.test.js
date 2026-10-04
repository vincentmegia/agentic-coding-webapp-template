import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { READING_STORIES, STORY_PAGE_COUNT, STORY_PAGE_MAX_CHARS } from './stories.js';
import { READING_PAGES } from './rules.js';

describe('Reading Nook stories', () => {
  test('there are several stories with distinct titles', () => {
    assert.ok(READING_STORIES.length >= 3);
    const titles = READING_STORIES.map((s) => s.title);
    assert.equal(new Set(titles).size, titles.length);
  });

  test('every story fills exactly READING_PAGES two-page spreads', () => {
    assert.equal(STORY_PAGE_COUNT, READING_PAGES * 2);
    for (const story of READING_STORIES) {
      assert.equal(story.pages.length, STORY_PAGE_COUNT, story.title);
    }
  });

  test('every page is non-empty and short enough to fit the drawn page', () => {
    for (const story of READING_STORIES) {
      story.pages.forEach((page, i) => {
        assert.ok(page.trim().length > 0, `${story.title} p${i + 1} is empty`);
        assert.ok(page.length <= STORY_PAGE_MAX_CHARS, `${story.title} p${i + 1} is ${page.length} chars`);
      });
    }
  });
});
