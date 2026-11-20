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

/** Global logging utility that can be centrally disabled. */

let isTracingEnabled = true;

/**
 * Centrally enable or disable logging/tracing.
 * @param enabled true to enable trace logging, false to disable.
 */
export function setTracingEnabled(enabled: boolean): void {
  isTracingEnabled = enabled;
}

/**
 * A replacement for console.log that can be centrally disabled.
 * @param args Arguments to log.
 */
export function trace(...args: any[]): void {
  if (isTracingEnabled) {
    console.log(...args);
  }
}