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

import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { RouteData } from '../types';

const formatDuration = (durationString: string): string => {
  if (!durationString) {
    return '—';
  }
  const seconds = parseInt(String(durationString).replace('s', ''), 10);
  if (isNaN(seconds)) return '—';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  let result = '';
  if (hours > 0) {
    result += `${hours} hr `;
  }
  if (minutes > 0) {
    result += `${minutes} min`;
  }
  if (result.trim() === '') {
    // For very short durations, show seconds.
    const remainingSeconds = seconds % 60;
    if (remainingSeconds > 0 || (hours === 0 && minutes === 0)) {
        result = `${remainingSeconds} sec`;
    }
  }
  return result.trim();
};

const formatDistance = (meters: number): string => {
  if (typeof meters !== 'number' || isNaN(meters)) {
    return '—';
  }
  // Using Imperial units for this example
  const miles = meters / 1609.34;
  if (miles >= 0.1) {
    return `${miles.toFixed(1)} mi`;
  }
  const feet = meters * 3.28084;
  return `${Math.round(feet)} ft`;
};

@customElement('route-display')
export class RouteDisplay extends LitElement {
  @property({ type: Object })
  route: RouteData | null = null;

  // Use light DOM for Tailwind compatibility
  protected createRenderRoot() {
    return this;
  }

  render() {
    if (!this.route) return html``;

    return html`
      <div class="border border-green-200/50 bg-green-50/50 rounded-lg p-3 mb-2 text-[#1A1C1E] text-sm font-sans" aria-label="Route details">
        <div class="flex items-center justify-around text-center">
          <div class="flex-1 px-1">
            <p class="text-xs text-green-800 font-semibold uppercase tracking-wider">Duration</p>
            <p class="text-xl font-bold text-green-900">${formatDuration(this.route.duration)}</p>
          </div>
          <div class="border-l border-green-200/60 h-10 mx-2"></div>
          <div class="flex-1 px-1">
            <p class="text-xs text-green-800 font-semibold uppercase tracking-wider">Distance</p>
            <p class="text-xl font-bold text-green-900">${formatDistance(this.route.distanceMeters)}</p>
          </div>
        </div>
      </div>
    `;
  }
}