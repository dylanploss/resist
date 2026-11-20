<!-- Small team logo in the top-right corner of every slide except the title slide. -->
<template>
  <img
    v-if="$nav.currentPage > 1"
    src="/logo.png"
    alt="Dylan David Ove logo"
    class="absolute top-3 right-4 h-10 opacity-90"
  />
</template>
