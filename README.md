# Lock In Flashcards

## Run locally

Unzip the archive and open a terminal in the `lock-in-flashcards` folder. Start the local server with this command.

```sh
python3 -m http.server
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

## Study

Open a course and choose **Study today** for its new, learning, and due review cards. The scheduler uses Anki’s classic SM-2 settings. New cards use 1-minute and 10-minute learning steps. A missed review enters a 10-minute relearning step. **Daily limits** lets you change the default of 20 new cards and 200 reviews per course.

Press **Space** or **Enter** to show the answer, then **1** for Again, **2** for Hard, **3** for Good, or **4** for Easy. A second press of Space or Enter selects Good. Each grade shows the next interval. Use Hard when you recall the answer with difficulty and Again when you forget it.

**Custom study** lets you study a course or selected sections ahead of schedule. Its answers also update due dates. **Review later** flags a card separately from its grade. Schedules, flags, and history are saved in your browser. Marks from the earlier version carry over, and their schedules start when you grade those cards here.

## Edit the flashcards

Edit the relevant UTF-8 CSV in `data/`. Keep `chapter,question,answer` as the first line and use one row per card. The first appearance of each chapter sets the section order. Quote fields containing commas, double quotes, or line breaks. Double any double quote inside a quoted field.

To add Cell & Molecular Biology, add rows beneath the header in `data/cell-molecular-biology.csv`. Reload the site after changing a CSV. Marks and session history are saved in the current browser for that site address.

## Deploy

1. Push the contents of `lock-in-flashcards` to a GitHub repository with `index.html` at its root.
2. Import that repository into Vercel and select **Other** as the Framework Preset.
3. Enable the Build Command override and leave the command empty. Leave the other build fields at their defaults, then deploy.

To host on GitHub Pages, open the repository’s **Settings → Pages**, choose **Deploy from a branch**, select your branch and **/ (root)**, and save.
