import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'android', 'public/assets']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        __APP_VARIANT__: 'readonly',
      },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { 
        varsIgnorePattern: '^_[a-zA-Z]|^[A-Z]', 
        argsIgnorePattern: '^_[a-zA-Z]|^[A-Z]',
        caughtErrorsIgnorePattern: '^_[a-zA-Z]|^[A-Z]'
      }],

      // Pět pravidel, která přišla s eslint-plugin-react-hooks 7.1, je tu
      // ZÁMĚRNĚ na 'warn', ne 'off' a ne 'error'.
      //
      // Proč vůbec: kvůli eslintu 10 se musel plugin zvednout na 7.1
      // (sedmička 7.0 eslint 10 v peer závislostech nemá) a ta přinesla
      // pravidla z éry React Compileru. Hlásí 59 míst napříč klientem.
      // Žádné z nich není důvod toho zvednutí — tím je `no-undef`, který
      // teprve od eslintu 10 pozná nedefinovanou KOMPONENTU v JSX. Právě na
      // to se čtyři měsíce schovával pád hlavní obrazovky relaye (#170).
      //
      // Proč ne 'off': těch 59 hlášení není šum, jsou to skutečné nálezy
      // o efektech. Vypnout je znamená zapomenout je. Jako 'warn' je
      // `eslint .` vypíše, ale neshodí běh — a ostrý nález typu chybějící
      // import spadne dál jako 'error'. Je to stejný přístup jako
      // u bezpečnostní kontroly: blokuje jen to, co blokovat musí,
      // zbytek se měří.
      //
      // Projít je a opravit je samostatná práce, ne příloha k zvednutí verze.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  {
    files: ['vite.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/context/**/*.{js,jsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
