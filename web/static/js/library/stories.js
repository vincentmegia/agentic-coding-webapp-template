// Short stories read at Library Shift's Reading Nook (v2.11: "add real
// words and let me read"). Purely decorative content — no gameplay reads
// the text itself. Every story has exactly STORY_PAGE_COUNT pages, shown
// two at a time as an open book (READING_PAGES spreads); stories.test.js
// enforces the count and a per-page length that fits the page at the
// overlay's font size.

/** Pages per story — two per spread, so this is 2 × rules.js's READING_PAGES. */
export const STORY_PAGE_COUNT = 12;

/** Upper bound on a page's text, in characters, so it fits the drawn page. */
export const STORY_PAGE_MAX_CHARS = 260;

export const READING_STORIES = [
  {
    title: 'A Quiet Afternoon',
    pages: [
      'The rain started just after lunch, soft at first, then steady enough that the street outside the library turned silver.',
      'Mrs. Abernathy came in shaking her umbrella like a wet dog. She always came on Tuesdays, and she always asked for the same thing: "Something with a garden in it."',
      'There was a whole shelf of gardens. Wild ones, tidy ones, gardens on rooftops and gardens at the bottom of the sea. She had read nearly all of them.',
      'Today she did not go to the shelf. She sat by the window instead, folded her hands, and watched the rain run down the glass in long crooked lines.',
      '"I planted tulips this morning," she said to no one in particular. "Forty of them. My knees will never forgive me."',
      'The librarian brought her a cup of tea from the staff room, which was against the rules, and set it on the sill without a word.',
      'Mrs. Abernathy smiled at the cup as if it were an old friend. Steam curled up against the window and fogged a small circle on the glass.',
      'With one finger she drew a flower in the fog. Then another. Then a little fence, and a sun, though there was no sun at all that day.',
      'A boy at the next table watched her, then breathed on his own patch of window and drew a very lopsided tree.',
      '"Needs roots," said Mrs. Abernathy, leaning over. The boy added roots. They went down and down, all the way to the bottom of the glass.',
      'By four o\'clock the rain had stopped. The window was covered in a whole fogged-up garden, slowly fading as the room warmed.',
      'Mrs. Abernathy picked up her umbrella and checked out nothing at all. "Best book I\'ve read in weeks," she said, and went home to her tulips.',
    ],
  },
  {
    title: 'The Lighthouse Keeper',
    pages: [
      'Ida kept the lighthouse at the end of the world, or at least at the end of the road, which on foggy nights felt like the same thing.',
      'Every evening she climbed the one hundred and twelve steps, wound the great clockwork, and lit the lamp that turned and turned until morning.',
      'Ships did not pass very often anymore. Most nights the light swept over empty water, a slow white finger writing nothing on the waves.',
      'Still, Ida climbed. "You never know who\'s out there," her grandfather used to say, "and it\'s rude to leave the porch light off."',
      'One winter night, a small boat appeared in the beam. It bobbed and drifted, its sail torn, a single lantern flickering at the bow.',
      'Ida flashed the lamp three times, the old signal for this way. The lantern flickered back. Slowly, the little boat turned toward the cove.',
      'It was a fisherman named Tomas, soaked to the bone and very embarrassed. "Got turned around," he said. "Fog came in like a wall."',
      'She gave him dry socks, hot soup, and the good chair by the stove. He fell asleep before the soup was finished, spoon still in his hand.',
      'In the morning the fog had lifted. The sea was flat and blue, and Tomas\'s boat looked much smaller in daylight than it had in the dark.',
      '"How do I thank you?" he asked at the door. Ida shrugged. "Wave when you pass," she said. "That\'s all a lighthouse ever wants."',
      'After that, every evening at dusk, a small boat passed the point, and a man in a yellow coat stood up in it and waved both arms.',
      'And every evening, one hundred and twelve steps up, the lamp blinked three times in reply: this way, this way, this way.',
    ],
  },
  {
    title: 'Tea for One',
    pages: [
      'Arthur had made tea for two every morning for forty-one years, and on the first morning he only needed one cup, he made two anyway.',
      'He sat at the kitchen table and looked at the second cup for a long time. It went cold. He did not pour it out.',
      'The next day he made two cups again. And the day after. It seemed wrong to stop, the way it seems wrong to stop a clock.',
      'On the fifth day there was a knock at the door. It was the girl from next door, holding a plate of slightly burnt biscuits.',
      '"Mum says you\'re to eat these," she announced. "She says you\'re not eating. Are you not eating?" Arthur admitted he was not eating very much.',
      'The girl looked past him into the kitchen and saw the two cups. "Is someone else here?" she asked, lowering her voice.',
      'Arthur thought about how to answer that. "Not anymore," he said at last. "But the cup didn\'t get the message."',
      'The girl considered this seriously. Then she marched in, sat down in the empty chair, and took a sip of the cold tea. She made a face.',
      '"It\'s freezing," she said. "You have to drink it while it\'s hot, or what\'s the point?" Arthur found, to his surprise, that he was laughing.',
      'He made a fresh pot. They ate the burnt biscuits, which were terrible, and she told him at great length about a dog she wanted.',
      'She came back the next morning, and the one after that. Arthur kept making two cups, and now both of them were finished.',
      'Some mornings he still thought of the other chair as hers. But it was good, he decided, for a chair to have someone sitting in it.',
    ],
  },
  {
    title: 'Paper Boats',
    pages: [
      'On the last day of school, Priya folded every page of her old maths homework into a paper boat. There were thirty-seven of them.',
      'She lined them up along the windowsill like a tiny fleet, each one a little different, some with sharp prows and some a bit lopsided.',
      '"What are they for?" asked her brother. Priya did not know yet. That was the best part of making something: you could decide later.',
      'That afternoon a summer storm rolled in, loud and warm, and the gutter outside their house turned into a rushing brown river.',
      'Priya looked at the river. She looked at the fleet. Then she grabbed all thirty-seven boats and ran outside in her socks.',
      'One by one she set them in the water. They spun, tipped, raced, and sailed off down the street toward the drain at the corner.',
      'Her brother came out too, then the twins from across the road, then old Mr. Okafor with a newspaper hat to keep the rain off.',
      'Soon everyone was folding. Receipts, flyers, a page from the phone book. Mr. Okafor made a boat so big it needed two hands to launch.',
      'They cheered for every boat that made it to the corner, and groaned for every one that capsized. Most of them capsized.',
      'When the rain stopped, the street was quiet and full of soggy paper. Priya\'s socks were ruined. She had never been happier.',
      'That night she found one last boat in her pocket, perfectly dry, folded from the page with her worst test score on it.',
      'She kept that one. She put it on the shelf above her bed, where it sailed, very bravely, for years and years.',
    ],
  },
  {
    title: 'The Long Walk Home',
    pages: [
      'The bus broke down three miles from town, and the driver said the next one would be at least an hour. Leo decided to walk.',
      'It was the kind of evening where the sky can\'t make up its mind: orange at the edges, purple in the middle, one early star already showing off.',
      'The road ran past fields of tall corn that whispered when the wind moved through them, as if they were passing along a secret.',
      'After the first mile, a scruffy brown dog trotted out of a ditch and fell into step beside him. It had no collar and no apparent plans.',
      '"I\'m going to town," Leo told it. The dog seemed to think that was a reasonable idea and kept walking, ears up, tail going.',
      'They passed a farmhouse with every window lit gold. Someone inside was playing a piano, not very well, the same tune over and over.',
      'Leo found himself humming it. By the second mile he knew all the wrong notes by heart and was humming those too.',
      'The stars came out properly then, hundreds of them, more than he ever saw in town. He walked slower so he could keep looking up.',
      'Near the bridge, the dog stopped, sat, and looked at a little house with a red door. The door opened, and a woman called, "Biscuit!"',
      'So the dog had plans after all. It licked Leo\'s hand once, very politely, and ran home to its red door and its dinner.',
      'The last mile he walked alone, but it didn\'t feel lonely. It felt like the end of a good story, the part where you slow down on purpose.',
      'When he finally got home, his feet hurt and he was late for supper. "Bus broke down," he said. He didn\'t say it was the best part of the day.',
    ],
  },
];
