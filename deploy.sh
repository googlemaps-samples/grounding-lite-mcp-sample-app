#!/bin/bash
# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.


# Exit immediately if a command exits with a non-zero status.
set -e

# Configuration
ENV_FILE="./.env"
GCP_PROJECT_ID=${1:-''}
GCP_REGION=${2:-''}

# --- Helper Functions ---

# Function to read a specific key from the .env file
get_env_key() {
    local key_name=$1
    # Note: This sed command handles optional quotes and trimming whitespace/comments
    local value=$(grep "^${key_name}=" "$ENV_FILE" | cut -d '=' -f 2- | tr -d '[:space:]' | sed 's/^"//;s/"$//;s/#[[:space:]]*.*//')
    echo "$value"
}

# --- Validation and Variable Loading ---

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: .env file not found at $ENV_FILE"
    exit 1
fi

if [ -z "$GCP_PROJECT_ID" ] || [ -z "$GCP_REGION" ]; then
    echo "Usage: ./deploy.sh [GCP_PROJECT_ID] [GCP_REGION]"
    echo "Example: ./deploy.sh my-gcp-project us-central1"
    exit 1
fi

# Read the required keys
SERVER_API_KEY=$(get_env_key "SERVER_API_KEY")
GOOGLE_MAPS_API_KEY=$(get_env_key "GOOGLE_MAPS_API_KEY")
if [ -z "$GOOGLE_MAPS_API_KEY" ]; then
    GOOGLE_MAPS_API_KEY=$(get_env_key "MAPS_API_KEY")
fi

# Validate that keys were successfully read
if [ -z "$SERVER_API_KEY" ]; then
    echo "Error: SERVER_API_KEY is missing or empty in $ENV_FILE"
    exit 1
fi

if [ -z "$GOOGLE_MAPS_API_KEY" ]; then
    echo "Error: GOOGLE_MAPS_API_KEY is missing or empty in $ENV_FILE"
    exit 1
fi

echo "--- Deploying to Google Cloud Run ---"
echo "Project: $GCP_PROJECT_ID"
echo "Region: $GCP_REGION"

# Execute the gcloud deploy command, passing the read variables securely
gcloud run deploy grounding-lite-app \
    --source . \
    --region "$GCP_REGION" \
    --platform managed \
    --allow-unauthenticated \
    --set-env-vars SERVER_API_KEY="$SERVER_API_KEY",GOOGLE_MAPS_API_KEY="$GOOGLE_MAPS_API_KEY" \
    --project "$GCP_PROJECT_ID"

echo "Deployment command completed."