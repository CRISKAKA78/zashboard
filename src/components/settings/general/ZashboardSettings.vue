<template>
  <div class="relative flex flex-col text-sm">
    <div class="flex flex-col gap-2 px-1">
      <a
        :href="OFFICIAL_DASHBOARD_REPOSITORY"
        target="_blank"
        class="text-lg font-semibold"
      >
        zashboard
      </a>
      <div
        aria-live="polite"
        class="flex flex-wrap gap-2"
      >
        <div class="badge badge-ghost h-auto gap-1.5 py-1">
          <span class="opacity-60">{{ $t('customDashboardVersion') }}</span>
          <code>{{ customDashboardVersion }}</code>
          <span
            v-if="commitId"
            class="text-xs opacity-50"
          >
            {{ commitId }}
          </span>
        </div>
        <a
          :href="OFFICIAL_DASHBOARD_REPOSITORY + '/releases/latest'"
          target="_blank"
          class="badge badge-ghost h-auto gap-1.5 py-1"
        >
          <span class="opacity-60">{{ $t('officialDashboardLatestVersion') }}</span>
          <code v-if="officialDashboardVersionStatus === 'ready'">
            {{ officialDashboardVersion }}
          </code>
          <span
            v-else-if="officialDashboardVersionStatus === 'loading'"
            class="loading loading-spinner loading-xs"
            :aria-label="$t('checkingVersion')"
          />
          <span
            v-else
            class="opacity-50"
            >{{ $t('versionUnavailable') }}</span
          >
        </a>
      </div>
    </div>

    <StyleSettings />
    <GeneralSettings />
  </div>
</template>

<script setup lang="ts">
import {
  customDashboardVersion,
  officialDashboardVersion,
  officialDashboardVersionStatus,
} from '@/assembly/version'
import { OFFICIAL_DASHBOARD_REPOSITORY } from '@/features/dashboard-version/dashboardVersion'
import GeneralSettings from './GeneralSettings.vue'
import StyleSettings from './StyleSettings.vue'

const commitId = __COMMIT_ID__
</script>
