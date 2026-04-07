import { defineConfig } from 'vite'

export default defineConfig({
    base: './',
    build: {
        outDir: '../custom_components/password/www',
        emptyOutDir: true,
    }
})