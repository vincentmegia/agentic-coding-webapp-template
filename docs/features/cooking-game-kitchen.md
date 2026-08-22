# Kitchen Shift — Kitchen Rules

> Split out of `docs/features/cooking-game.md` (v3.11, "so it's more
> organized") along with `cooking-game-food-server.md` and
> `cooking-game-customer.md` — together these three replace what used to
> be one "Business Rules / Validation" section. This doc covers the
> kitchen as a cooking *system*: what dishes exist and what they need,
> the cookware/cook-timing mechanics, and the Dining/Kitchen room split.
> Everything else about the feature (Status, Summary, Scope, User Flow,
> Visual Direction, UI, Client-side Behavior, Routes/Data Model, Security,
> Testing Plan, Open Questions, Definition of Done) stays in the main doc.

## Recipes, gated by shift band

(illustrative — tune during build, same status the Fishing Game's
fish/hazard tables started at before their own playtesting pass). Dishes
carry no individual point value — see the food-server doc's Shift
paycheck rule for why:

| Shift range | Dish              | Station | Cookware | Ingredients                      |
| ------------- | ------------------- | --------- | ---------- | ----------------------------------- |
| 1–5             | Garden Salad          | none (cabinet/fridge only) | none | Lettuce + Tomato        |
| 1–5             | Grilled Cheese         | Stove     | Pan | Bread + Cheese                       |
| 6–10            | Burger                 | Stove     | Pan | Buns + Patty + Lettuce                 |
| 6–10            | Pancakes                | Stove     | Pan | Flour + Egg + Milk                    |
| 11–15           | Roast Chicken           | Oven      | Baking Tray | Chicken + Herbs                       |
| 11–15           | Pasta                   | Stove     | Pan | Noodles + Sauce                       |
| 16–20           | Steak Dinner            | Stove     | Pan | Steak + Potato + Herbs                |
| 16–20           | Soufflé (signature)      | Oven      | Baking Tray | Egg + Cheese + Flour                  |

A dish's ingredients come from the Fridge (cold: Cheese, Milk, Chicken,
Patty, Steak, Lettuce, Tomato, Egg, Lemonade, Matcha) or the Cabinet (dry:
Bread, Flour, Noodles, Herbs, Buns, Sauce, Potato, Star Cake, Cake).
Which dishes customers can order is drawn only from bands unlocked up to
the current shift, same "grows, never shrinks" shape as the Fishing
Game's fish-band gating. Lemonade/Matcha/Star Cake/Cake exist only for
Mel's and Olive & Oliver's dedicated orders (see the customer doc) — no
`RECIPE_BANDS` dish uses them, so they never show up in a normal random
customer's order.

## Cookware

Every Stove dish needs a Pan and every Oven dish needs a Baking Tray (a
Rice Cooker also lives in the Cookware Closet, present for flavor but not
required by any current dish). Unlike ingredients, cookware is a one-time
pickup per shift — acquired once from the Cookware Closet, it's available
for every dish that needs it for the rest of the shift, never consumed or
re-gathered, and a burned/ruined dish only loses its ingredients, not its
cookware.

## Cook-timing is a binary success zone

Not a graded quality tier: the sweeping gauge has one "success" window —
a second interaction while the sweep is inside it finishes the dish;
anywhere outside it burns/ruins the ingredients (0 value, must
re-gather). Sharp Knife gear (food-server doc's Gear upgrades) widens the
success window per level. Sweep speed scales up slightly with shift
number, the cooking-side equivalent of descent speed ramping with depth
in the Fishing Game.

## The Dining/Kitchen room split (v3.1)

Exactly one room is ever active; only its stations render, are clickable,
or count for hover tooltips (`floor-plan.js`'s `stationsInRoom`). Room
switching (via either door station or the HUD's room button) is
available in **every** shift phase, not just `playing` — a deliberate
rule, not an oversight, since the closing sequence needs stations from
both rooms in order (clean tables and shut down in Dining, wash dishes in
Kitchen — see the food-server doc's Closing sequence rule) and
restricting switching to `playing` would strand the player mid-closing
with no way to reach the next required station.
