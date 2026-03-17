// js/app.js
// ================================================================
// Section 1: Supabase Client Initialization
// ================================================================

// The supabase global object is made available by the CDN script
// tag in index.html. We destructure createClient from it so we
// can call createClient() directly without typing supabase.createClient().
const { createClient } = supabase;

const SUPABASE_URL = "https://mnwowwgzjsounxhcoonu.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_IxXIJWmbOEIS7SeFCZaY7g_zu2T2OFR";

// db is our connection handle. Every database call starts with db.from(...)
const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ================================================================
// Section 2: Application State
// ================================================================

// currentProfileId holds the UUID of whichever profile is currently
// displayed in the centre panel. It starts as null (nothing selected).
// Most action buttons check this first and show an error if it is null.
let currentProfileId = null;

// ================================================================
// Section 3: Helper Functions
// ================================================================

// setStatus — writes a message to the status bar at the bottom.
// Pass isError = true to turn the bar red, indicating a problem.
function setStatus(message, isError = false) {
  const bar = document.getElementById("status-message");
  const footer = document.getElementById("status-bar");
  bar.textContent = message;
  footer.style.background = isError ? "#6b1a1a" : "var(--clr-status-bg)";
  footer.style.color = isError ? "#ffcccc" : "var(--clr-status-text)";
}

// clearCentrePanel — resets the centre panel to its default
// "nothing selected" state and clears currentProfileId.
function clearCentrePanel() {
  document.getElementById("profile-pic").src = "resources/images/default.png";
  document.getElementById("profile-name").textContent = "No Profile Selected";
  document.getElementById("profile-status").textContent = "\u2014";
  document.getElementById("profile-quote").textContent = "\u2014";
  document.getElementById("friends-list").innerHTML = "";
  currentProfileId = null;
}

// displayProfile — fills the centre panel with a profile's data.
// profile  : the full row object returned from Supabase
// friends  : array of { id, name } objects (resolved in selectProfile)
function displayProfile(profile, friends = []) {
  document.getElementById("profile-pic").src =
    profile.picture || "resources/images/default.png";
  document.getElementById("profile-name").textContent = profile.name;
  document.getElementById("profile-status").textContent =
    profile.status || "(no status set)";
  document.getElementById("profile-quote").textContent =
    profile.quote || "(no quote set)";
  currentProfileId = profile.id;
  renderFriendsList(friends);
  setStatus(`Displaying ${profile.name}.`);
}

// renderFriendsList — builds the friends list HTML inside the
// centre panel. Expects an array of { id, name } plain objects.
// (Previously this expected f.profiles.name from a Supabase join.
//  The new bidirectional query resolves names separately, so the
//  shape is now just f.name — simpler and consistent.)
function renderFriendsList(friends) {
  const box = document.getElementById("friends-list");
  box.innerHTML = "";

  if (friends.length === 0) {
    box.innerHTML = '<p class="empty-state">No friends yet.</p>';
    return;
  }

  friends.forEach((f) => {
    const div = document.createElement("div");
    div.className = "friend-entry";
    div.textContent = f.name; // f.name directly — no nested .profiles.name
    box.appendChild(div);
  });
}

// ================================================================
// Section 4: CRUD Functions
// ================================================================

// loadProfileList — fetches all profiles ordered by name and
// renders them as clickable rows in the left panel list.
async function loadProfileList() {
  try {
    const { data, error } = await db
      .from("profiles")
      .select("id, name, picture")
      .order("name", { ascending: true });

    if (error) throw error;

    const container = document.getElementById("profile-list");
    container.innerHTML = "";

    if (data.length === 0) {
      container.innerHTML = '<p class="empty-state">No profiles found.</p>';
      return;
    }

    data.forEach((profile) => {
      // Build a clickable row for each profile
      const row = document.createElement("div");
      row.className = "profile-item";
      row.dataset.id = profile.id; // store the UUID for later use

      // Circular thumbnail image
      const img = document.createElement("img");
      img.className = "list-thumb";
      img.src = profile.picture || "resources/images/default.png";
      img.alt = profile.name;
      // If the image file is missing, fall back to the default silhouette
      img.onerror = () => {
        img.src = "resources/images/default.png";
      };

      // Profile name label
      const span = document.createElement("span");
      span.textContent = profile.name;

      row.appendChild(img);
      row.appendChild(span);
      // Clicking the row selects and displays that profile
      row.addEventListener("click", () => selectProfile(profile.id));
      container.appendChild(row);
    });
  } catch (err) {
    setStatus(`Error loading profiles: ${err.message}`, true);
  }
}

// ================================================================
// selectProfile — BIDIRECTIONAL FRIENDSHIP QUERY
// ================================================================
// This is the most important function to understand for bidirectional
// friendships.
//
// OLD behaviour (directed only):
//   SELECT * FROM friends WHERE profile_id = X
//   This only returned friendships that profile X had INITIATED.
//   If B added A but A had not added B, A's list would not show B.
//
// NEW behaviour (undirected / bidirectional):
//   Because addFriend always inserts ONE canonical row with the
//   smaller UUID in profile_id, a friendship between A and B is
//   stored as exactly one row. That row might have A in profile_id
//   or B in profile_id depending on which UUID is smaller.
//
//   To find ALL friends of X we therefore need:
//     WHERE profile_id = X   (X is on the "left" side of the row)
//     OR
//     WHERE friend_id  = X   (X is on the "right" side of the row)
//
//   Supabase exposes this as .or(`profile_id.eq.${X},friend_id.eq.${X}`)
//
//   From each matching row we then pick the OTHER column's UUID
//   (the one that is NOT X) to get the friend's ID.
//
//   Finally we fetch all those friend IDs in a single .in() query
//   to resolve their names.
// ================================================================
async function selectProfile(profileId) {
  try {
    // 1. Highlight the clicked row in the left panel list
    document.querySelectorAll("#profile-list .profile-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.id === profileId);
    });

    // 2. Fetch the full profile row for the centre panel display
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("*")
      .eq("id", profileId)
      .single(); // .single() returns a plain object instead of a one-item array

    if (profileError) throw profileError;

    // 3. Fetch all friendship rows that involve this profile.
    //    .or() matches rows where profileId appears in EITHER column.
    //    We only need the two UUID columns — no join needed yet.
    const { data: rows, error: friendsError } = await db
      .from("friends")
      .select("profile_id, friend_id")
      .or(`profile_id.eq.${profileId},friend_id.eq.${profileId}`);

    if (friendsError) throw friendsError;

    // 4. From each row, extract the UUID of the OTHER person
    //    (the one that is not the currently selected profile).
    //    Example: if profileId = A and the row is (A, B), take B.
    //             if profileId = A and the row is (C, A), take C.
    const friendIds = rows.map((row) =>
      row.profile_id === profileId ? row.friend_id : row.profile_id,
    );

    // 5. If there are any friends, fetch their names in one query.
    //    .in("id", friendIds) is the SQL equivalent of WHERE id IN (...)
    let friendNames = [];
    if (friendIds.length > 0) {
      const { data: nameRows, error: nameError } = await db
        .from("profiles")
        .select("id, name")
        .in("id", friendIds)
        .order("name", { ascending: true }); // show friends alphabetically

      if (nameError) throw nameError;
      friendNames = nameRows; // shape: [{ id, name }, ...]
    }

    // 6. Render the centre panel with the resolved friends list
    displayProfile(profile, friendNames);
  } catch (err) {
    setStatus(`Error selecting profile: ${err.message}`, true);
  }
}

// addProfile — inserts a new profile row with just a name.
// Status, quote, and picture all use their database default values.
async function addProfile() {
  const nameInput = document.getElementById("input-name");
  const name = nameInput.value.trim();

  if (!name) {
    setStatus("Error: Name field is empty. Please enter a name.", true);
    return;
  }

  try {
    const { data, error } = await db
      .from("profiles")
      .insert({ name })
      .select()
      .single();

    if (error) {
      // Postgres error code 23505 = unique constraint violation
      // This fires when a profile with the same name already exists
      if (error.code === "23505") {
        setStatus(`Error: A profile named "${name}" already exists.`, true);
      } else {
        throw error;
      }
      return;
    }

    nameInput.value = "";
    await loadProfileList(); // refresh the list to show the new profile
    await selectProfile(data.id); // immediately select and display it
    setStatus(`Profile "${name}" created successfully.`);
  } catch (err) {
    setStatus(`Error adding profile: ${err.message}`, true);
  }
}

// lookUpProfile — searches for a profile by partial name match
// (case-insensitive) and selects the first result.
async function lookUpProfile() {
  const query = document.getElementById("input-name").value.trim();

  if (!query) {
    setStatus(
      "Error: Name field is empty. Please enter a name to search.",
      true,
    );
    return;
  }

  try {
    // .ilike() = case-insensitive LIKE. The % wildcards match anything
    // before or after the search term, so "bill" matches "Bill Gates".
    const { data, error } = await db
      .from("profiles")
      .select("id, name")
      .ilike("name", `%${query}%`)
      .order("name", { ascending: true })
      .limit(1);

    if (error) throw error;

    if (data.length === 0) {
      setStatus(`No profile found matching "${query}".`, true);
      clearCentrePanel();
      return;
    }

    await selectProfile(data[0].id);
  } catch (err) {
    setStatus(`Error looking up profile: ${err.message}`, true);
  }
}

// deleteProfile — deletes the currently selected profile after
// asking the user to confirm. The ON DELETE CASCADE on the friends
// table automatically removes all friendship rows for this profile.
async function deleteProfile() {
  if (!currentProfileId) {
    setStatus(
      "Error: No profile is selected. Click a profile in the list first.",
      true,
    );
    return;
  }

  const name = document.getElementById("profile-name").textContent;

  if (
    !window.confirm(`Delete the profile for "${name}"? This cannot be undone.`)
  ) {
    setStatus("Deletion cancelled.");
    return;
  }

  try {
    const { error } = await db
      .from("profiles")
      .delete()
      .eq("id", currentProfileId);

    if (error) throw error;

    clearCentrePanel();
    await loadProfileList();
    setStatus(
      `Profile "${name}" deleted. All friendship records removed automatically.`,
    );
  } catch (err) {
    setStatus(`Error deleting profile: ${err.message}`, true);
  }
}

// changeStatus — updates the status column for the current profile
// and immediately reflects the change in the centre panel.
async function changeStatus() {
  if (!currentProfileId) {
    setStatus("Error: No profile is selected.", true);
    return;
  }
  const newStatus = document.getElementById("input-status").value.trim();
  if (!newStatus) {
    setStatus("Error: Status field is empty.", true);
    return;
  }
  try {
    const { error } = await db
      .from("profiles")
      .update({ status: newStatus })
      .eq("id", currentProfileId);

    if (error) throw error;

    document.getElementById("profile-status").textContent = newStatus;
    document.getElementById("input-status").value = "";
    setStatus("Status updated.");
  } catch (err) {
    setStatus(`Error updating status: ${err.message}`, true);
  }
}

// changeQuote — updates the favourite quote for the current profile.
async function changeQuote() {
  if (!currentProfileId) {
    setStatus("Error: No profile is selected.", true);
    return;
  }
  const newQuote = document.getElementById("input-quote").value.trim();
  if (!newQuote) {
    setStatus("Error: Quote field is empty.", true);
    return;
  }
  try {
    const { error } = await db
      .from("profiles")
      .update({ quote: newQuote })
      .eq("id", currentProfileId);

    if (error) throw error;

    document.getElementById("profile-quote").textContent = newQuote;
    document.getElementById("input-quote").value = "";
    setStatus("Favorite quote updated.");
  } catch (err) {
    setStatus(`Error updating quote: ${err.message}`, true);
  }
}

// changePicture — updates the picture path for the current profile
// and refreshes both the large centre-panel image and the small
// thumbnail in the left panel list.
async function changePicture() {
  if (!currentProfileId) {
    setStatus("Error: No profile is selected.", true);
    return;
  }

  const raw = document.getElementById("input-picture").value.trim();
  if (!raw) {
    setStatus("Error: Picture field is empty.", true);
    return;
  }

  // Auto-prepend resources/ if the user typed just a filename (e.g. 'ada.png')
  const newPicture = raw.startsWith("resources/") ? raw : "resources/" + raw;

  try {
    const { error } = await db
      .from("profiles")
      .update({ picture: newPicture })
      .eq("id", currentProfileId);

    if (error) throw error;

    // Update the large centre-panel image
    document.getElementById("profile-pic").src = newPicture;

    // Update the small thumbnail in the active left-panel row
    const activeThumb = document.querySelector(
      "#profile-list .profile-item.active .list-thumb",
    );
    if (activeThumb) activeThumb.src = newPicture;

    document.getElementById("input-picture").value = "";
    setStatus(`Picture updated.`);
  } catch (err) {
    setStatus(`Error updating picture: ${err.message}`, true);
  }
}
// async function changePicture() {
//   if (!currentProfileId) {
//     setStatus("Error: No profile is selected.", true);
//     return;
//   }
//   const newPicture = document.getElementById("input-picture").value.trim();
//   if (!newPicture) {
//     setStatus("Error: Picture field is empty.", true);
//     return;
//   }
//   try {
//     const { error } = await db
//       .from("profiles")
//       .update({ picture: newPicture })
//       .eq("id", currentProfileId);

//     if (error) throw error;

//     // Update the large profile image in the centre panel
//     document.getElementById("profile-pic").src = newPicture;
//     document.getElementById("input-picture").value = "";

//     // Also update the small thumbnail in the left panel list
//     const activeThumb = document.querySelector(
//       "#profile-list .profile-item.active .list-thumb",
//     );
//     if (activeThumb) activeThumb.src = newPicture;

//     setStatus("Picture updated.");
//   } catch (err) {
//     setStatus(`Error updating picture: ${err.message}`, true);
//   }
// }

// ================================================================
// Section 5: Friends Management — Bidirectional
// ================================================================
//
// HOW BIDIRECTIONAL STORAGE WORKS
// ────────────────────────────────
// The friends table stores ONE row per friendship pair (not two).
// The pair is always stored in a canonical order: the UUID that
// is lexicographically SMALLER goes in profile_id, the LARGER
// goes in friend_id. This is called "normalization."
//
// Example UUIDs (simplified):
//   A = "3a..."
//   B = "9f..."
//   Since "3a" < "9f", the row is stored as (profile_id=A, friend_id=B)
//
// If we did NOT normalize, we could end up with:
//   Row 1: (A, B)  — added by A
//   Row 2: (B, A)  — added by B
// That would mean the UNIQUE constraint treats them as different rows
// and we would have two separate records for the same friendship.
//
// By always writing LEAST(A,B) into profile_id and GREATEST(A,B)
// into friend_id, (A,B) and (B,A) both map to the same row, so
// the UNIQUE constraint correctly prevents duplicates.
//
// addFriend and removeFriend BOTH apply this normalization before
// touching the database. selectProfile reads both columns to find
// all friendships for a given profile (see Section 4 above).
// ================================================================

// addFriend — creates a bidirectional friendship between the
// currently selected profile and the named friend profile.
async function addFriend() {
  if (!currentProfileId) {
    setStatus("Error: No profile is selected.", true);
    return;
  }
  const friendName = document.getElementById("input-friend").value.trim();
  if (!friendName) {
    setStatus("Error: Friend name field is empty.", true);
    return;
  }

  try {
    // 1. Find the friend's profile by name (case-insensitive)
    const { data: found, error: findError } = await db
      .from("profiles")
      .select("id, name")
      .ilike("name", friendName)
      .limit(1);

    if (findError) throw findError;

    if (found.length === 0) {
      setStatus(
        `Error: No profile named "${friendName}" exists. Add that profile first.`,
        true,
      );
      return;
    }

    const friendId = found[0].id;

    // 2. Prevent self-friendship (belt and suspenders — the DB also
    //    enforces this via CHECK constraint, but we show a clear message here)
    if (friendId === currentProfileId) {
      setStatus("Error: A profile cannot be friends with itself.", true);
      return;
    }

    // 3. Normalize the pair so the smaller UUID is always in profile_id.
    //    JavaScript string comparison (<) works correctly on UUID strings
    //    because UUIDs use only lowercase hex digits and hyphens.
    //
    //    BEFORE normalization: we might have (currentProfileId, friendId)
    //                       or (friendId, currentProfileId)
    //    AFTER normalization:  always (smaller, larger)
    //
    //    This ensures (A, B) and (B, A) produce the same row, so the
    //    UNIQUE(profile_id, friend_id) constraint catches duplicates
    //    regardless of which direction the friendship was initiated.
    const [canonA, canonB] =
      currentProfileId < friendId
        ? [currentProfileId, friendId] // currentProfileId is smaller
        : [friendId, currentProfileId]; // friendId is smaller

    // 4. Insert the single canonical row
    const { error: insertError } = await db
      .from("friends")
      .insert({ profile_id: canonA, friend_id: canonB });

    if (insertError) {
      // 23505 = unique constraint violation: friendship already exists
      if (insertError.code === "23505") {
        setStatus(`"${found[0].name}" is already a friend.`, true);
      } else {
        throw insertError;
      }
      return;
    }

    document.getElementById("input-friend").value = "";

    // Re-render the current profile so the new friend appears in the list.
    // selectProfile re-runs the bidirectional query, so both profiles
    // will show each other when either one is selected.
    await selectProfile(currentProfileId);
    setStatus(`"${found[0].name}" added as a friend (bidirectional).`);
  } catch (err) {
    setStatus(`Error adding friend: ${err.message}`, true);
  }
}

// removeFriend — removes the bidirectional friendship between the
// currently selected profile and the named friend profile.
// Uses the same UUID normalization as addFriend to target the
// correct canonical row in the database.
async function removeFriend() {
  if (!currentProfileId) {
    setStatus("Error: No profile is selected.", true);
    return;
  }
  const friendName = document.getElementById("input-friend").value.trim();
  if (!friendName) {
    setStatus("Error: Friend name field is empty.", true);
    return;
  }

  try {
    // 1. Find the friend's profile by name
    const { data: found, error: findError } = await db
      .from("profiles")
      .select("id, name")
      .ilike("name", friendName)
      .limit(1);

    if (findError) throw findError;

    if (found.length === 0) {
      setStatus(`Error: No profile named "${friendName}" exists.`, true);
      return;
    }

    const friendId = found[0].id;

    // 2. Apply the SAME normalization used in addFriend.
    //    If we stored the row as (A, B) we must delete (A, B).
    //    If we try to delete (B, A) the query finds no matching row
    //    and silently does nothing — the friendship appears to still exist.
    //    Normalization guarantees we always address the right row.
    const [canonA, canonB] =
      currentProfileId < friendId
        ? [currentProfileId, friendId]
        : [friendId, currentProfileId];

    // 3. Delete the single canonical row
    const { error: deleteError } = await db
      .from("friends")
      .delete()
      .eq("profile_id", canonA)
      .eq("friend_id", canonB);

    if (deleteError) throw deleteError;

    document.getElementById("input-friend").value = "";

    // Re-render the current profile. The removed friend will no longer
    // appear here, and if you navigate to the friend's profile they
    // will no longer show the current profile either.
    await selectProfile(currentProfileId);
    setStatus(`"${found[0].name}" removed from friends (both directions).`);
  } catch (err) {
    setStatus(`Error removing friend: ${err.message}`, true);
  }
}

// ================================================================
// Section 6: Event Listener Setup
// ================================================================
//
// DOMContentLoaded fires once the HTML has been fully parsed but
// before images have loaded. Wrapping everything here ensures
// getElementById calls never return null because the element
// does not exist yet.
// ================================================================

document.addEventListener("DOMContentLoaded", async () => {
  // ── Left panel ───────────────────────────────────────────────
  document.getElementById("btn-add").addEventListener("click", addProfile);
  document
    .getElementById("btn-lookup")
    .addEventListener("click", lookUpProfile);
  document
    .getElementById("btn-delete")
    .addEventListener("click", deleteProfile);

  // Pressing Enter in the name field triggers Add (not Lookup).
  // This matches the expected behaviour: type a name, press Enter,
  // profile is created.
  document.getElementById("input-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addProfile();
  });

  // ── Right panel: status ──────────────────────────────────────
  document.getElementById("btn-status").addEventListener("click", changeStatus);
  document.getElementById("input-status").addEventListener("keydown", (e) => {
    if (e.key === "Enter") changeStatus();
  });

  // ── Right panel: quote ───────────────────────────────────────
  document.getElementById("btn-quote").addEventListener("click", changeQuote);
  document.getElementById("input-quote").addEventListener("keydown", (e) => {
    if (e.key === "Enter") changeQuote();
  });

  // ── Right panel: picture ─────────────────────────────────────
  document
    .getElementById("btn-picture")
    .addEventListener("click", changePicture);

  // ── Right panel: friends (shared input field) ────────────────
  document
    .getElementById("btn-add-friend")
    .addEventListener("click", addFriend);
  document
    .getElementById("btn-remove-friend")
    .addEventListener("click", removeFriend);

  // ── Exit button ──────────────────────────────────────────────
  // window.close() only works if the tab was opened by a script.
  // In most cases it does nothing, so we fall back to a message.
  document.getElementById("btn-exit").addEventListener("click", () => {
    if (!window.close()) {
      setStatus("To exit, close this browser tab.");
    }
  });

  // ── Initial data load ────────────────────────────────────────
  // Populate the profile list as soon as the page finishes loading.
  await loadProfileList();
  setStatus("Ready. Select a profile from the list or add a new one.");
});