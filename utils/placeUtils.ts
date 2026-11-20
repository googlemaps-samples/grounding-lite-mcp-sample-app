/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export const cleanPlaceName = (displayName: { text?: string } | string | undefined): string => {
  if (!displayName) return '';
  const text = typeof displayName === 'string' ? displayName : displayName.text;
  if (!text) return '';
  // Remove common suffixes like " (The)" or " (A)" and trim whitespace
  return text.replace(/\s+\(The\)$/i, '').replace(/\s+\(A\)$/i, '').trim();
};

export const formatPlaceNameForLabel = (name: string): string => {
    const maxLength = 30;
    const splitThreshold = 14;

    // 1. Truncate name if necessary (Will be refactored to use truncateLabel later)
    let processedName = name;
    if (processedName.length > maxLength) {
        processedName = processedName.substring(0, maxLength) + '...';
    }

    // 2. Only attempt to break if overall length is > 14
    if (processedName.length <= splitThreshold) return processedName;

    const words = processedName.split(' ');
    if (words.length <= 1) return processedName;

    let bestSplitIndex = -1;

    // Find the best split point: maximize the length of the first line (up to 14 chars)
    for (let i = 1; i < words.length; i++) {
        const potentialFirstLine = words.slice(0, i).join(' ');

        // Check if the potential first line is 14 characters or less
        if (potentialFirstLine.length <= splitThreshold) {
            bestSplitIndex = i;
        } else {
            // If the current word makes the line too long, stop searching
            break;
        }
    }

    // If a valid split point was found (bestSplitIndex > 0) and it leaves content for the second line (bestSplitIndex < words.length)
    if (bestSplitIndex > 0 && bestSplitIndex < words.length) {
        const firstLine = words.slice(0, bestSplitIndex).join(' ');
        const secondLine = words.slice(bestSplitIndex).join(' ');
        return `${firstLine}\n${secondLine}`;
    }

    // If no good split found, return the (potentially truncated) name.
    return processedName;
};

export const truncateLabel = (name: string, maxLength: number = 30): string => {
  if (name.length > maxLength) {
      return name.substring(0, maxLength) + '...';
  }
  return name;
};

export const decodeHTMLEntities = (text: string): string => {
  const tempEl = document.createElement('textarea');
  tempEl.innerHTML = text;
  return tempEl.value;
};