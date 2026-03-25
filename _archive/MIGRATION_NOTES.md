# Vite Migration - Completion Guide

This document outlines the Vite migration from the single-file PWA to a multi-file project structure.

## Completed Components

### Created Files:
- ✅ `vite.config.js` - Vite configuration
- ✅ `index.html` - New Vite entry point
- ✅ `package.json` - Dependencies
- ✅ `src/main.jsx` - React entry point with service worker registration
- ✅ `src/styles/global.css` - Global styles from original `<style>` block
- ✅ `src/App.jsx` - Root component with auth flow, booting, setup wizard
- ✅ `src/constants/theme.js` - C (colors) and SL (schedule labels)
- ✅ `src/constants/supabase.js` - SB_URL and SB_KEY
- ✅ `src/constants/labels.js` - All constant strings and arrays
- ✅ `src/utils/auth.js` - All auth functions (login, signup, token refresh, OAuth)
- ✅ `src/utils/db.js` - Complete Database class with all methods
- ✅ `src/utils/ai-usage.js` - AI usage tracking with daily limits
- ✅ `src/utils/pdf.js` - Lazy-load utilities for pdf-lib, pdf.js, mammoth
- ✅ `src/components/MDRLogo.jsx` - Logo component
- ✅ `src/components/ConfirmOverlay.jsx` - Confirm dialog (replaces browser confirm)
- ✅ `src/components/OfflineBanner.jsx` - Offline/synced status banner
- ✅ `src/components/LoginScreen.jsx` - Login and signup UI
- ✅ `src/components/InstallBanner.jsx` - PWA install prompt

## Remaining Components to Create

The following components are extracted from the original file but need to be created as separate files. Lines references are from the original 8000+ line HTML file:

### 1. SupportChat.jsx (Lines 333-473)
- Support chat widget with conversation management
- Real-time message polling
- Guest or authenticated user support

### 2. AccountSettings.jsx (Lines 863-1352)
- Profile management
- Company linking and templates
- Timezone settings
- Push notification subscriptions
- Subscription management
- Account deletion

### 3. TemplateFieldEditor.jsx (Lines 1354-1671)
- Click-to-place field editor for PDF templates
- PDF rendering with canvas
- Field placement, resizing, and management
- Nearby text suggestions

### 4. CreateJob.jsx (Lines 1674-2471)
- Template upload (PDF, DOCX, JPG, PNG)
- Field parsing and detection
- Save/reuse templates
- Job frequency and reminders
- Field configuration UI

### 5. ArchivedJobs.jsx (Lines 2474-2496)
- Display archived jobs list
- Job selection

### 6. WorkLogEditor.jsx (Lines 2521-4018)
- Work log entry editor
- Contractor management
- Photo uploads with compression
- AI photo descriptions
- Weather integration
- Custom categories
- Survey questions
- PDF generation with pdf-lib

### 7. ReportEditor.jsx (Lines 4021-5647)
- Main report editing interface
- Field management (editable, locked, auto-fill)
- Photo management and layout
- PDF preview and generation
- Field value tracking
- Autosave functionality

### 8. JobDetail.jsx (Lines 5649-6372)
- Job details view
- Template management
- Job settings
- Report history
- Job deletion

### 9. TrainingCenter.jsx (Lines 6455-6576)
- Educational content
- Feature walkthroughs
- Best practices

### 10. Dashboard.jsx (Lines 6578-7285)
- Main app interface
- Job cards
- Navigation
- Page routing

### 11. SetupWizard.jsx (Lines 7287-7670)
- Onboarding flow
- Profile setup
- Timezone selection
- Template preparation guide
- Subscription info

## Key Implementation Notes

### Imports Pattern
Each component should import:
```jsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { C, SL } from '../constants/theme'
import { db } from '../utils/db'
import { getAuthToken, setAuthToken } from '../utils/auth'
```

### PDFs
Use dynamic imports instead of CDN:
```javascript
import { ensurePdfLib, ensurePdfJs, ensureMammoth } from '../utils/pdf'
```

### Database
Import and use the singleton:
```javascript
import { db } from '../utils/db'
const jobs = await db.jobs(userId)
```

### Colors and Constants
```javascript
import { C } from '../constants/theme'
import { TIMEZONE_OPTIONS, DAYS_OF_WEEK } from '../constants/labels'
```

## Next Steps

1. Extract each component from the original HTML file
2. Create separate .jsx files following the patterns above
3. Ensure all imports are correct and relative paths work
4. Test each component independently
5. Update any service worker logic (sw.js references)
6. Copy public assets (manifest.json, icons, sw.js, logo.jpg) to `/public/`
7. Run `npm install` and `npm run dev`

## File Structure
```
src/
  main.jsx
  App.jsx
  constants/
    theme.js          ✅
    supabase.js       ✅
    labels.js         ✅
  utils/
    auth.js           ✅
    db.js             ✅
    pdf.js            ✅
    ai-usage.js       ✅
  components/
    MDRLogo.jsx       ✅
    ConfirmOverlay.jsx    ✅
    OfflineBanner.jsx     ✅
    InstallBanner.jsx     ✅
    LoginScreen.jsx       ✅
    SupportChat.jsx       (TODO)
    AccountSettings.jsx   (TODO)
    TemplateFieldEditor.jsx (TODO)
    CreateJob.jsx         (TODO)
    ArchivedJobs.jsx      (TODO)
    WorkLogEditor.jsx     (TODO)
    ReportEditor.jsx      (TODO)
    JobDetail.jsx         (TODO)
    TrainingCenter.jsx    (TODO)
    Dashboard.jsx         (TODO)
    SetupWizard.jsx       (TODO)
  styles/
    global.css        ✅
public/
  manifest.json       (COPY FROM ORIGINAL)
  sw.js              (COPY FROM ORIGINAL)
  icon-192.png       (COPY FROM ORIGINAL)
  icon-512.png       (COPY FROM ORIGINAL)
  logo.jpg           (COPY FROM ORIGINAL)
vite.config.js       ✅
package.json         ✅
index.html           ✅
```

## Important: Component Line References

The line numbers shown above are from the original collapsed HTML/JSX file. When extracting:
- Focus on the function body and JSX
- Extract all React hooks used within that function
- Include all imported utilities and constants
- Maintain the component's prop interface
- Keep the visual styling identical
