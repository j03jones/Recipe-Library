"""Browser check of the account features against a FAKE in-memory Supabase (the real one is not reachable
from the test machine). It proves the app's screens and requests behave; it does not prove the real
database rules, which are tested separately by supabase/test/run.sh.

    python tools/e2e_cloud.py
"""
import asyncio
import json
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 8792
URL = f"http://127.0.0.1:{PORT}/"
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"}
results, errors = [], []
CLIENT_RPCS = ("claim_client", "respond_to_meal", "rate_meal", "set_favorite", "request_meal", "update_my_preferences")


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


class Fake:
    def __init__(self):
        self.online = True
        self.users = {}      # email -> dict(pw,id,name,role)
        self.restaurants = {}
        self.members = []    # dict(user_id, restaurant_id, member_role)
        self.invites = {}    # code -> dict(kind, restaurant_id, member_role, uses, max)
        self.recipes = {}
        self.add_user("chef@example.com", "adminpass1", "Joe", "admin")
        self.log = []
        self.user_data = {}
        self.tick = 0
        self.requests = {}   # id -> invite request
        self.notified = []   # admin emails about new requests
        self.open_signup = False
        self.sent = []       # emailed invites
        self.households = {}  # id -> dict(name, code, list, list_at, members=[user ids])

    def add_user(self, email, pw, name, role):
        uid = str(uuid.uuid4())
        self.users[email] = dict(pw=pw, id=uid, name=name, role=role, email=email)
        return uid

    # ---- meal prep clients: a stand-in for supabase/add_clients.sql, access rules included.
    # The chef (role admin) sees everything; a client sees only their own record, their menus once
    # sent, and never the chef-only link to the recipe.
    async def clients_api(self, req, path, q, body, user, ok, eq):
        names = ("clients", "client_notes", "client_menus", "client_meals", "client_meal_private", "client_requests",
                 "client_favorites", "client_menu_templates")
        rpcs = CLIENT_RPCS
        table = path.replace("/rest/v1/", "")
        rpc = path.replace("/rest/v1/rpc/", "")
        if table not in names and rpc not in rpcs:
            return await ok({"message": f"unhandled {req.method} {path}"}, 404)
        if getattr(self, "no_clients", False):
            return await ok({"message": "Could not find the table 'public.clients' in the schema cache"}, 404)
        if not user:
            return await ok({"message": "permission denied"}, 401)
        db = self.__dict__.setdefault("cdb", {n: {} for n in names})
        admin = user["role"] == "admin"
        mine = [c["id"] for c in db["clients"].values() if c.get("user_id") == user["id"]]

        def menu_for_client(menu_id):
            m = db["client_menus"].get(menu_id)
            return m if m and m["client_id"] in mine and m["status"] in ("sent", "closed") else None

        if rpc in rpcs:
            if rpc == "claim_client":
                n = 0
                for c in db["clients"].values():
                    if not c.get("user_id") and c["email"] and c["email"].lower() == user["email"].lower():
                        c["user_id"] = user["id"]; n += 1
                return await ok(n)
            if rpc in ("respond_to_meal", "rate_meal"):
                meal = db["client_meals"].get(body["p_meal"])
                menu = menu_for_client(meal["menu_id"]) if meal else None
                if not menu or (rpc == "respond_to_meal" and menu["status"] != "sent"):
                    return await ok({"message": "This menu is not open for answers."}, 400)
                if rpc == "respond_to_meal":
                    meal.update(status="approved" if body["p_approve"] else "swap", client_note=(body.get("p_note") or "").strip(),
                                responded_at="2026-11-12T10:00:00Z")
                else:
                    meal.update(rating=body["p_rating"], feedback=(body.get("p_feedback") or "").strip())
                return await ok(None)
            if body["p_client"] not in mine:
                return await ok({"message": "Not your account."}, 400)
            if rpc == "set_favorite":
                key = (body["p_client"], body["p_title"].strip().lower())
                if body["p_on"]:
                    db["client_favorites"][key] = dict(client_id=body["p_client"], dish=key[1], title=body["p_title"].strip())
                else:
                    db["client_favorites"].pop(key, None)
                return await ok(None)
            if rpc == "request_meal":
                rid = str(uuid.uuid4())
                db["client_requests"][rid] = dict(id=rid, client_id=body["p_client"], title=body["p_title"].strip(),
                                                  note=(body.get("p_note") or "").strip(), status="open", created_at=f"2026-11-12T10:00:{len(db['client_requests']):02d}Z")
                return await ok(rid)
            known = ["Peanuts", "Tree nuts", "Milk / dairy", "Eggs", "Wheat / gluten", "Soy", "Fish", "Shellfish", "Sesame"]
            db["clients"][body["p_client"]].update(allergens=[a for a in known if a in body["p_allergens"]],
                                                   allergy_notes=body["p_allergy_notes"].strip(), dislikes=body["p_dislikes"].strip())
            return await ok(None)

        rows = db[table]
        key = "client_id" if table == "client_notes" else "meal_id" if table == "client_meal_private" else "id"
        if req.method == "GET":
            if table == "clients":
                out = [dict(c, notes=({"notes": db["client_notes"][c["id"]]["notes"]} if c["id"] in db["client_notes"] else None))
                       for c in rows.values()] if admin else [dict(c) for c in rows.values() if c["id"] in mine]
                uid = eq("user_id")
                if uid:
                    out = [c for c in out if c.get("user_id") == uid]
                return await ok(sorted(out, key=lambda c: c["name"]))
            if table == "client_menus":
                out = []
                for m in rows.values():
                    if not admin and not menu_for_client(m["id"]):
                        continue
                    if eq("client_id") and m["client_id"] != eq("client_id"):
                        continue
                    if eq("week_start") and m["week_start"] != eq("week_start"):
                        continue
                    meals = [dict(x) for x in db["client_meals"].values() if x["menu_id"] == m["id"]]
                    if admin:
                        for x in meals:
                            x["private"] = db["client_meal_private"].get(x["id"])
                    out.append(dict(m, meals=meals))
                return await ok(sorted(out, key=lambda m: m["week_start"], reverse=True))
            if table in ("client_requests", "client_favorites"):
                out = [r for r in rows.values() if (admin or r["client_id"] in mine) and (not eq("client_id") or r["client_id"] == eq("client_id"))]
                return await ok(sorted(out, key=lambda r: r.get("created_at", r.get("title", "")), reverse=table == "client_requests"))
            if not admin:
                return await ok([])
            return await ok(list(rows.values()))
        if not admin:
            return await ok({"message": "new row violates row-level security policy"}, 403)
        if req.method == "POST":
            row = dict(body)
            if key == "id":
                row.setdefault("id", str(uuid.uuid4()))
            defaults = {
                "clients": dict(user_id=None, email="", plan="custom", entrees=5, servings=2, weekly_fee=0, allergens=[], allergy_notes="",
                                dislikes="", targets={}, active=True, created_at="2026-11-12T09:00:00Z"),
                "client_menus": dict(status="draft", approve_by=None, note="", sent_at=None),
                "client_meals": dict(position=0, description="", ingredients=[], allergens=[], nutrition={}, servings=1, reheat="", storage="",
                                     use_by=None, status="proposed", client_note="", rating=None, feedback=""),
            }.get(table, {})
            row = {**defaults, **row}
            rows[row[key]] = row
            return await ok([row], 201)
        target = eq(key)
        if req.method == "PATCH" and target in rows:
            rows[target].update(body)
            return await ok([rows[target]])
        if req.method == "DELETE" and target in rows:
            del rows[target]
            if table == "clients":
                for mid in [m["id"] for m in db["client_menus"].values() if m["client_id"] == target]:
                    del db["client_menus"][mid]
            if table == "client_menus":
                for xid in [x["id"] for x in db["client_meals"].values() if x["menu_id"] == target]:
                    del db["client_meals"][xid]
            return await ok(None, 204)
        return await ok([], 200)

    def by_token(self, req):
        tok = req.headers.get("authorization", "").replace("Bearer ", "")
        return next((u for u in self.users.values() if tok == f"tok-{u['id']}"), None)

    def token_resp(self, u):
        return {"access_token": f"tok-{u['id']}", "refresh_token": "r", "expires_in": 3600, "user": {"id": u["id"], "email": u["email"]}}

    @staticmethod
    def on_plan(r):
        # as the database decides it (add_restaurant_trials.sql): active, or a trial that has not ended
        from datetime import datetime, timezone
        ends = r.get("trial_ends_at")
        return r["subscription_status"] == "active" or (r["subscription_status"] == "trialing" and (
            not ends or datetime.fromisoformat(ends.replace("Z", "+00:00")) > datetime.now(timezone.utc)))

    def member_of(self, user, rid, role=None):
        return any(m["user_id"] == user["id"] and m["restaurant_id"] == rid and (not role or m["member_role"] == role) for m in self.members)

    def costing_of(self, user, rid):
        """add_restaurant_team.sql: owners always edit; staff as the owner set them."""
        m = next((m for m in self.members if m["user_id"] == user["id"] and m["restaurant_id"] == rid), None)
        return "none" if not m else "edit" if m["member_role"] == "owner" else m.get("costing", "none")

    def team_can_change(self, user, row):
        """add_restaurant_kitchen.sql: the team changes its own recipes (staff the ones they added), never the chef's."""
        if not row or row["scope"] != "restaurant" or not self.member_of(user, row["restaurant_id"]):
            return False
        if not self.on_plan(self.restaurants[row["restaurant_id"]]):
            return False
        if any(x["id"] == row["owner_id"] and x["role"] == "admin" for x in self.users.values()):
            return False
        return row["owner_id"] == user["id"] or self.member_of(user, row["restaurant_id"], "owner")

    def visible(self, u):
        out = []
        for r in self.recipes.values():
            mem = any(m["user_id"] == u["id"] for m in self.members if m["restaurant_id"] == r.get("restaurant_id"))
            active = r.get("restaurant_id") and self.on_plan(self.restaurants[r["restaurant_id"]])
            if (u["role"] == "admin" or r["owner_id"] == u["id"] or (r["scope"] == "community" and r["status"] == "approved")
                    or (r["scope"] == "restaurant" and mem and active)):
                out.append(r)
        return out

    async def handle(self, route):
        req = route.request
        if req.method == "OPTIONS":
            return await route.fulfill(status=204, headers=CORS)
        if not self.online:
            return await route.abort()
        u = urlparse(req.url)
        path, q = u.path, parse_qs(u.query)
        body = json.loads(req.post_data) if req.post_data and "/storage/" not in req.url else None
        self.log.append((req.method, path))
        user = self.by_token(req)

        def ok(data, status=200):
            return route.fulfill(status=status, headers={**CORS, "content-type": "application/json"}, body=json.dumps(data))

        def eq(name):
            v = q.get(name, [None])[0]
            return v[3:] if v and v.startswith("eq.") else None

        if path == "/auth/v1/token":
            x = self.users.get((body or {}).get("email"))
            if not x or x["pw"] != body["password"]:
                return await ok({"error_description": "Invalid login credentials"}, 400)
            return await ok(self.token_resp(x))
        if path == "/rest/v1/rpc/signup_open":
            return await ok(self.open_signup)
        if path.startswith("/rest/v1/client") or path.replace("/rest/v1/rpc/", "") in CLIENT_RPCS:
            return await self.clients_api(req, path, q, body, user, ok, eq)
        if path == "/functions/v1/request-invite":
            new = not any(r["email"] == body["email"].lower() and r["status"] == "waiting" for r in self.requests.values())
            rid = str(uuid.uuid4())
            self.requests[rid] = dict(id=rid, name=body["name"], email=body["email"].lower(), about=body["about"], note=body["note"],
                                      status="waiting", created_at="2026-11-05T10:00:00Z")
            if new:
                self.notified.append(body["email"].lower())
            return await ok({"ok": True, "new": new, "emailed": new})
        if path == "/auth/v1/signup" and self.open_signup and not (body["data"].get("invite_code") or ""):
            uid = self.add_user(body["email"], body["password"], body["data"].get("display_name"), "student")
            return await ok(self.token_resp(self.users[body["email"]]))
        if path == "/auth/v1/signup" and not (body["data"].get("invite_code") or "") and any(
                not c.get("user_id") and c["email"] and c["email"].lower() == body["email"].lower()
                for c in self.__dict__.get("cdb", {}).get("clients", {}).values()):
            self.add_user(body["email"], body["password"], body["data"].get("display_name"), "student")
            self.users[body["email"]]["meta"] = body["data"]
            return await ok(self.token_resp(self.users[body["email"]]))
        if path == "/auth/v1/signup":
            code = (body["data"].get("invite_code") or "").upper()
            inv = self.invites.get(code)
            if not inv or inv["uses"] >= inv["max"]:
                return await ok({"message": "Database error saving new user"}, 500)
            inv["uses"] += 1
            uid = self.add_user(body["email"], body["password"], body["data"].get("display_name"), "client" if inv["kind"] == "restaurant" else "student")
            if inv["kind"] == "restaurant":
                self.members.append(dict(user_id=uid, restaurant_id=inv["restaurant_id"], member_role=inv["member_role"]))
            return await ok(self.token_resp(self.users[body["email"]]))
        if path == "/auth/v1/recover":
            return await ok({})
        if path == "/rest/v1/rpc/invite_info":
            inv = self.invites.get((body.get("p_code") or "").upper())
            if not inv:
                return await ok([{"status": "not found", "kind": None, "restaurant_name": None, "member_role": None}])
            return await ok([{"status": "active" if inv["uses"] < inv["max"] else "used up", "kind": inv["kind"],
                              "restaurant_name": (self.restaurants.get(inv["restaurant_id"]) or {}).get("name"), "member_role": inv["member_role"]}])
        if path == "/rest/v1/rpc/request_invite":
            rid = str(uuid.uuid4())
            self.requests[rid] = dict(id=rid, name=body["p_name"], email=body["p_email"].lower(), about=body["p_about"], note=body["p_note"],
                                      status="waiting", created_at="2026-11-05T10:00:00Z")
            return await route.fulfill(status=204, headers=CORS)
        if path == "/auth/v1/logout":
            return await ok({})
        if user is None:
            return await ok({"message": "JWT expired"}, 401)
        if path == "/auth/v1/user" and req.method == "PUT":
            user["pw"] = body["password"]
            return await ok({"id": user["id"]})
        if path == "/rest/v1/user_data":
            if getattr(self, "no_table", False):
                return await ok({"message": "Could not find the table 'public.user_data' in the schema cache"}, 404)
            if req.method == "GET":
                return await ok([self.user_data[user["id"]]] if user["id"] in self.user_data else [])
            self.tick += 1
            # an upsert that merges: only the columns sent are changed (stars, library_photos, planner)
            row = {"stars": [], **self.user_data.get(user["id"], {}), **body, "user_id": user["id"],
                   "updated_at": f"2026-11-04T10:00:{self.tick:02d}Z"}
            if getattr(self, "no_planner", False) and "planner" in body:
                return await ok({"message": "Could not find the 'planner' column of 'user_data' in the schema cache"}, 400)
            self.user_data[user["id"]] = row
            return await ok([row], 201)
        if path == "/rest/v1/profiles":
            if "avatar=not.is.null" in (u.query or ""):
                return await ok([])
            return await ok([{"display_name": user["name"], "role": user["role"]}])
        if path == "/rest/v1/rpc/admin_list_people":
            if user["role"] != "admin":
                return await ok({"message": "Only the admin can see the list of people."}, 400)
            return await ok([dict(id=x["id"], display_name=x["name"], email=x["email"], role=x["role"], invite_code=None,
                                  restaurants=[self.restaurants[m["restaurant_id"]]["name"] for m in self.members if m["user_id"] == x["id"] and m["restaurant_id"] in self.restaurants],
                                  joined_at="2026-11-05T10:00:00Z", email_confirmed=True, last_sign_in_at=None,
                                  private_recipes=sum(1 for r in self.recipes.values() if r["owner_id"] == x["id"] and r["scope"] == "private"))
                             for x in self.users.values()])
        if path == "/rest/v1/restaurant_members":
            if eq("restaurant_id"):     # a restaurant's team (members and the admin may list it)
                team = [m for m in self.members if m["restaurant_id"] == eq("restaurant_id")]
                if user["role"] != "admin" and not any(m["user_id"] == user["id"] for m in team):
                    return await ok([])
                return await ok([{"user_id": m["user_id"], "member_role": m["member_role"]} for m in team])
            return await ok([{**m, "costing": m.get("costing", "none"), "restaurant": self.restaurants[m["restaurant_id"]]}
                             for m in self.members if m["user_id"] == user["id"]])
        if path == "/rest/v1/rpc/restaurant_team":
            rid_ = body["p_restaurant"]
            if user["role"] != "admin" and not self.member_of(user, rid_, "owner"):
                return await ok({"message": "Only the restaurant's owners can see the team."}, 400)
            byid = {x["id"]: x for x in self.users.values()}
            return await ok([dict(user_id=m["user_id"], display_name=byid[m["user_id"]]["name"] or "", email=byid[m["user_id"]]["email"],
                                  member_role=m["member_role"], costing="edit" if m["member_role"] == "owner" else m.get("costing", "none"),
                                  joined_at="2026-11-16T10:00:00Z") for m in self.members if m["restaurant_id"] == rid_])
        if path == "/rest/v1/rpc/set_member_costing":
            rid_ = body["p_restaurant"]
            if user["role"] != "admin" and not self.member_of(user, rid_, "owner"):
                return await ok({"message": "Only the restaurant's owners can change who sees the costing."}, 400)
            m = next((m for m in self.members if m["restaurant_id"] == rid_ and m["user_id"] == body["p_user"] and m["member_role"] == "staff"), None)
            if not m:
                return await ok({"message": "That person is not on this restaurant's staff."}, 400)
            m["costing"] = body["p_costing"]
            return await ok(None)
        if path == "/rest/v1/rpc/remove_member":
            rid_ = body["p_restaurant"]
            if user["role"] != "admin" and not self.member_of(user, rid_, "owner"):
                return await ok({"message": "You are not allowed to remove members of this restaurant."}, 400)
            self.members[:] = [m for m in self.members if not (m["restaurant_id"] == rid_ and m["user_id"] == body["p_user"])]
            return await ok(None)
        if path == "/rest/v1/restaurant_messages":
            msgs = self.__dict__.setdefault("messages", {})
            if req.method == "POST":
                if not self.member_of(user, body["restaurant_id"]):
                    return await ok({"message": "new row violates row-level security policy"}, 403)
                mid = str(uuid.uuid4())
                msgs[mid] = dict(body, id=mid, author_id=user["id"], status="open", created_at=f"2026-11-16T12:00:{len(msgs):02d}Z")
                return await ok(None, 201)
            if req.method == "PATCH":
                if user["role"] != "admin" or eq("id") not in msgs:
                    return await ok([])
                msgs[eq("id")].update(body)
                return await ok(None, 204)
            rows = [x for x in msgs.values() if user["role"] == "admin" or x["author_id"] == user["id"]]
            if eq("restaurant_id"):
                rows = [x for x in rows if x["restaurant_id"] == eq("restaurant_id")]
            return await ok(sorted(rows, key=lambda x: x["created_at"], reverse=True))
        if path == "/rest/v1/restaurant_kitchen":   # a restaurant's shared price book (add_restaurant_kitchen.sql)
            kit = self.__dict__.setdefault("kitchens", {})
            if req.method == "GET":
                rid_ = eq("restaurant_id")
                if user["role"] != "admin" and self.costing_of(user, rid_) == "none":
                    return await ok([])
                return await ok([{"prices": kit[rid_]}] if rid_ in kit else [])
            rid_ = body["restaurant_id"]
            if user["role"] != "admin" and not (self.costing_of(user, rid_) == "edit" and self.on_plan(self.restaurants[rid_])):
                return await ok({"message": "new row violates row-level security policy"}, 403)
            kit[rid_] = body["prices"]
            return await ok(None, 201)
        if path == "/rest/v1/recipes":
            if req.method == "GET":
                return await ok(self.visible(user))
            if req.method == "POST":
                if body.get("scope") == "restaurant" and user["role"] != "admin" and not (
                        body.get("owner_id") == user["id"] and self.member_of(user, body.get("restaurant_id"))
                        and self.on_plan(self.restaurants[body["restaurant_id"]])):
                    return await ok({"message": "new row violates row-level security policy"}, 403)
                private = [r for r in self.recipes.values() if r["owner_id"] == user["id"] and r["scope"] == "private"]
                if user["role"] != "admin" and len(private) >= 2 and not any(m["user_id"] == user["id"] for m in self.members):
                    return await ok({"message": "Free plan limit reached (2 recipes)"}, 400)
                row = {"id": str(uuid.uuid4()), "scope": "private", "status": "approved", "restaurant_id": None, "source_recipe_id": None, "author_name": None, "review_note": None, **body}
                self.recipes[row["id"]] = row
                return await ok([row], 201)
            rid = eq("id")
            row = self.recipes.get(rid)
            if req.method == "DELETE":
                gone = []
                if row and (user["role"] == "admin" or (row["owner_id"] == user["id"] and row["scope"] != "restaurant") or self.team_can_change(user, row)):
                    gone = [self.recipes.pop(rid)]
                if "return=representation" in (req.headers.get("prefer") or ""):
                    return await ok(gone)
                return await route.fulfill(status=204, headers=CORS)
            if req.method == "PATCH":
                if not row or not (user["role"] == "admin" or (row["owner_id"] == user["id"] and row["scope"] == "private") or self.team_can_change(user, row)):
                    return await ok([])
                row.update(body)
                return await ok([row])
        if path == "/functions/v1/import-recipe":   # made-up page; the real function reads the page's schema.org block
            return await ok({"url": body["url"], "site": "", "recipe": {
                "@type": "Recipe", "name": "Test Lentil Soup", "author": {"name": "Pat Example"},
                "recipeYield": ["4", "4 bowls"], "recipeIngredient": ["1 1/2 cups lentils", "½ tsp salt"],
                "recipeInstructions": [{"@type": "HowToStep", "text": "Simmer."}, {"@type": "HowToStep", "text": "Serve."}]}})
        if path == "/rest/v1/rpc/share_link_to_community":
            src = self.recipes[body["p_recipe"]]
            o = src["body"]["src"]
            row = dict(id=str(uuid.uuid4()), owner_id=user["id"], scope="community", status="pending", restaurant_id=None, review_note=None,
                       title=src["title"], categories=src.get("categories", []), source_recipe_id=src["id"], author_name=user["name"],
                       body=dict(kind="link", title=src["title"], tags=[], yq="", yu="", yr="", dir="", ings=[], src=o))
            self.recipes[row["id"]] = row
            return await ok(row["id"])
        if path == "/rest/v1/rpc/submit_to_community":
            src = self.recipes[body["p_recipe"]]
            if (src.get("body") or {}).get("src", {}).get("url"):
                return await ok({"message": "This recipe came from another website, so it stays private."}, 400)
            row = dict(src, id=str(uuid.uuid4()), scope="community", status="pending", source_recipe_id=src["id"], author_name=user["name"])
            self.recipes[row["id"]] = row
            return await ok(row["id"])
        if path == "/rest/v1/app_settings":
            if user["role"] != "admin":
                return await ok([])
            self.open_signup = bool(body["open_signup"])
            return await route.fulfill(status=204, headers=CORS)
        if path == "/rest/v1/invite_requests":
            if user["role"] != "admin":
                return await ok([])
            if req.method == "GET":
                return await ok([r for r in self.requests.values() if r["status"] == "waiting"])
            self.requests[eq("id")].update(body)
            return await ok([self.requests[eq("id")]])
        if path == "/functions/v1/send-invite":
            if user["role"] != "admin":
                return await ok({"error": "You are not allowed to create this invite."}, 403)
            if body["email"] in self.users:
                return await ok({"error": "That email already has an account. They can sign in, or use “Forgot password?”."}, 409)
            code = "CODE" + uuid.uuid4().hex[:6].upper()
            self.invites[code] = dict(kind=body["kind"], restaurant_id=body["restaurant_id"], member_role=body["member_role"], uses=0, max=1)
            self.sent.append(dict(body, code=code))
            if body.get("request_id"):
                self.requests[body["request_id"]]["status"] = "invited"
            return await ok({"ok": True, "code": code})
        if path.startswith("/storage/v1/object/list/photos"):
            return await ok([])
        files = self.__dict__.setdefault("files", {})
        if path.startswith("/storage/v1/object/photos/") and req.method == "POST":
            name = path[len("/storage/v1/object/photos/"):]
            if user["role"] != "admin" and not name.startswith(f"recipes/{user['id']}/") and not name.startswith(f"avatars/{user['id']}/"):
                return await ok({"message": "new row violates row-level security policy"}, 403)
            files[name] = req.post_data_buffer
            return await ok({"Key": f"photos/{name}"})
        if path.startswith("/storage/v1/object/authenticated/photos/"):
            name = path[len("/storage/v1/object/authenticated/photos/"):]
            if name not in files:
                return await ok({"message": "Object not found"}, 404)
            return await route.fulfill(status=200, headers={**CORS, "content-type": "image/jpeg"}, body=files[name])
        if path == "/storage/v1/object/photos" and req.method == "DELETE":
            return await ok([])
        if path.startswith("/rest/v1/rpc/") and "household" in path:
            mine = next((h for h in self.households.values() if user["id"] in h["members"]), None)
            name_of = {u["id"]: u["name"] for u in self.users.values()}
            if path.endswith("/household_info"):
                return await ok([] if not mine else [dict(id=mine["id"], name=mine["name"], code=mine["code"], list=mine["list"],
                                                         list_at=mine["list_at"], members=[name_of.get(m, "Someone").split(" ")[0] for m in mine["members"]])])
            if path.endswith("/create_household"):
                if mine:
                    return await ok({"message": "You are already in a household. Leave it first."}, 400)
                hid = str(uuid.uuid4()); code = uuid.uuid4().hex[:6].upper()
                self.households[hid] = dict(id=hid, name=body["p_name"], code=code, list={}, list_at=0, members=[user["id"]])
                return await ok(code)
            if path.endswith("/join_household"):
                h = next((h for h in self.households.values() if h["code"] == body["p_code"].strip().upper()), None)
                if not h:
                    return await ok({"message": "No household has that code. Check it and try again."}, 400)
                h["members"].append(user["id"])
                return await route.fulfill(status=204, headers=CORS)
            if path.endswith("/leave_household"):
                if mine:
                    mine["members"].remove(user["id"])
                return await route.fulfill(status=204, headers=CORS)
            if path.endswith("/save_household_list"):
                mine["list"] = body["p_list"]; mine["list_at"] = max(mine["list_at"] + 1, body["p_at"])
                return await route.fulfill(status=204, headers=CORS)
        if path == "/rest/v1/rpc/delete_my_account":
            if user["role"] == "admin":
                return await ok({"message": "The administrator account cannot be deleted from the app."}, 400)
            self.recipes = {k: r for k, r in self.recipes.items() if r["owner_id"] != user["id"]}
            del self.users[user["email"]]
            return await route.fulfill(status=204, headers=CORS)
        if path == "/rest/v1/rpc/admin_list_invites":
            return await ok([dict(code=c, kind=i["kind"], restaurant_name=(self.restaurants.get(i["restaurant_id"]) or {}).get("name"), member_role=i["member_role"],
                                  max_uses=i["max"], uses=i["uses"], expires_at=None, cancelled_at=None, created_at="2026-11-05T10:00:00Z",
                                  status="active" if i["uses"] < i["max"] else "used up", used_by=[], email=None) for c, i in self.invites.items()])
        if path == "/rest/v1/rpc/create_invite":
            code = "CODE" + uuid.uuid4().hex[:6].upper()
            self.invites[code] = dict(kind=body["p_kind"], restaurant_id=body["p_restaurant"], member_role=body["p_member_role"], uses=0, max=body["p_max_uses"])
            return await ok(code)
        if path == "/rest/v1/restaurants":
            if req.method == "GET":
                return await ok(list(self.restaurants.values()))
            if req.method == "POST":
                r = {"id": str(uuid.uuid4()), "subscription_status": "inactive", "seat_limit": 3, **body}
                self.restaurants[r["id"]] = r
                return await ok([r], 201)
            if req.method == "PATCH":
                self.restaurants[eq("id")].update(body)
                return await route.fulfill(status=204, headers=CORS)
            if req.method == "DELETE":
                gone = self.restaurants.pop(eq("id"), None)
                for k in [k for k, r in self.recipes.items() if r.get("restaurant_id") == eq("id")]:
                    del self.recipes[k]
                return await ok([gone] if gone else [])
        return await ok({"message": f"unhandled {req.method} {path}"}, 404)


async def new_page(b, fake, w=390, h=844):
    ctx = await b.new_context(viewport={"width": w, "height": h}, accept_downloads=True, reduced_motion="reduce")
    await ctx.route(re.compile(r"https://.*\.supabase\.co/.*"), fake.handle)
    page = await ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    return ctx, page


async def close_dialog(page, title_part=""):
    """Close the confirmation dialog shown after signing in / up. Returns its text."""
    sel = "dialog.infodialog[open]" + (f":has-text('{title_part}')" if title_part else "")
    await page.wait_for_selector(sel)
    text = await page.inner_text(sel)
    await page.click("dialog.infodialog[open] button:has-text('OK')")
    return text


async def sign_in(page, email, pw):
    await page.goto(URL + "#/settings")
    await page.wait_for_selector("input[type=email]")
    await page.fill("input[type=email]", email)
    await page.fill("input[type=password]", pw)
    await page.click("button[type=submit]")
    await close_dialog(page, "Welcome back")
    await page.wait_for_selector("text=Sign out")


async def admin_tab(admin, name):
    """Admin tools has tabs (Restaurants, People, Invites, Community): show one."""
    await admin.click(f".admintab:has-text('{name}')")


async def open_card(admin, name):
    """Restaurant cards in Admin tools fold away: open this one."""
    await admin.wait_for_selector(f"details.restcard summary:has-text('{name}')")
    await admin.evaluate("""(n) => { for (const d of document.querySelectorAll('details.restcard'))
      if (d.querySelector(':scope > summary strong').textContent === n) d.open = true; }""", name)


async def make_link(admin, who="student", restaurant=None):
    """Admin tools > Invites > Invite someone > Make a link & QR code. Returns (code, link)."""
    await admin_tab(admin, "Invites")
    await admin.select_option("select[aria-label='Who are you inviting']", who)
    if restaurant:
        await admin.select_option("select[aria-label=Restaurant]", label=restaurant)
    old = await admin.locator(".invite-share input.link").first.input_value() if await admin.locator("section .invite-share input.link").count() else ""
    await admin.click("button:has-text('Make a link & QR code')")
    await admin.wait_for_function("(o) => { const i = document.querySelector('section .invite-share input.link'); return i && i.value !== o; }", arg=old)
    link = await admin.locator("section .invite-share input.link").first.input_value()
    return link.rsplit("/", 1)[1], link


async def main():
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", str(ROOT / "web")],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        return await run()
    finally:
        server.terminate()


async def run():
    fake = Fake()
    async with async_playwright() as p:
        b = await p.chromium.launch()

        # ---- admin
        actx, admin = await new_page(b, fake)
        await admin.goto(URL + "#/settings")
        await admin.wait_for_selector("input[type=email]")
        await admin.fill("input[type=email]", "chef@example.com")
        await admin.fill("input[type=password]", "wrong")
        await admin.click("button[type=submit]")
        await admin.wait_for_selector(".note:has-text('Wrong email')")
        check("wrong password shows a friendly message", True)
        await admin.fill("input[type=password]", "adminpass1")
        await admin.click("button[type=submit]")
        check("signing in shows a welcome-back dialog", "Welcome back, Joe" in await close_dialog(admin))
        await admin.wait_for_selector("text=Sign out")
        check("admin sees Admin tools link", await admin.locator("a:has-text('Admin tools')").count() == 1)

        await admin.click("a:has-text('Admin tools')")
        await admin.wait_for_selector("h1:has-text('Admin tools')")
        await admin.fill("input[aria-label='New restaurant name']", "Maple Street Grill")
        await admin.click("button:has-text('Add restaurant')")
        await admin.wait_for_selector("strong:has-text('Maple Street Grill')")
        check("admin can add a restaurant", len(fake.restaurants) == 1)
        rid = next(iter(fake.restaurants))
        await admin.select_option("select[aria-label='Subscription for Maple Street Grill']", "active")
        await admin.wait_for_timeout(300)
        check("admin can mark a restaurant active", fake.restaurants[rid]["subscription_status"] == "active")

        # ---- a restaurant on a free trial, its owner invited, and its collection filled from the library (v0.27)
        from datetime import datetime, timedelta, timezone
        await admin.fill("input[aria-label='New restaurant name']", "Test Kitchen")
        await admin.fill("input[aria-label='Owner’s name']", "Jo Owner")
        await admin.fill("input[aria-label='Owner’s email']", "jo+test@example.com")
        await admin.click("button:has-text('Add restaurant')")
        await admin.wait_for_selector("strong:has-text('Test Kitchen')")
        tk = next(r for r in fake.restaurants.values() if r["name"] == "Test Kitchen")
        ends = datetime.fromisoformat(tk["trial_ends_at"].replace("Z", "+00:00"))
        check("a new restaurant starts on a 14-day free trial", tk["subscription_status"] == "trialing"
              and timedelta(days=13, hours=23) < ends - datetime.now(timezone.utc) <= timedelta(days=14), tk)
        check("its owner is emailed an owner invite", any(x["email"] == "jo+test@example.com" and x["member_role"] == "owner"
                                                         and x["restaurant_id"] == tk["id"] for x in fake.sent), fake.sent[-1:])
        await open_card(admin, "Test Kitchen")
        check("the card says how long the trial has left", "14 days left" in await admin.inner_text(".restcard:has-text('Test Kitchen')"))
        await admin.screenshot(path="/tmp/cloud_admin_restaurants.png", full_page=True)
        check("each restaurant has a link to view its portal as its team sees it",
              await admin.get_attribute(".restcard:has-text('Test Kitchen') a.preview", "href") == f"https://jonesridgekitchen.com/my-meals/?preview={tk['id']}")
        # one of the chef's own recipes (an imported recipe book): the picker opens on them, no typing needed
        fake.recipes["mine1"] = dict(id="mine1", owner_id=fake.users["chef@example.com"]["id"], scope="private", restaurant_id=None, status="approved",
                                     title="House Chimichurri", categories=["Sauces"], author_name=None, review_note=None, source_recipe_id=None,
                                     body=dict(tags=[], yq="4", yu="cups", yr="", dir="Blend everything.", ings=[["3", "", "cup", "parsley", ""]]))
        await admin.reload()
        await open_card(admin, "Test Kitchen")
        await admin.click(".restcard:has-text('Test Kitchen') details.collection summary")
        await admin.click(".restcard:has-text('Test Kitchen') button:has-text('Add a recipe')")
        await admin.wait_for_selector("dialog.pickdialog .picklist")
        check("adding to a restaurant opens on your own recipes, listed without searching",
              await admin.get_attribute("dialog.pickdialog .pickscope button:has-text('Mine')", "aria-pressed") == "true"
              and await admin.locator("dialog.pickdialog .picklist button:has-text('House Chimichurri')").count() == 1
              and await admin.locator("dialog.pickdialog input[aria-label=Note]").count() == 0)
        await admin.fill("dialog.pickdialog input[type=search]", "gumbo")
        await admin.wait_for_timeout(300)
        check("a search with none of yours matching shows all recipes instead", "From all recipes" in await admin.inner_text("dialog.pickdialog .picklist")
              and await admin.locator("dialog.pickdialog .picklist button").count() > 0)
        await admin.click("dialog.pickdialog .pickscope button:has-text('All recipes')")
        await admin.fill("dialog.pickdialog input[type=search]", "chimichurri")
        await admin.wait_for_timeout(300)
        check("in All recipes, yours come first and say Mine", "House Chimichurri" in await admin.inner_text("dialog.pickdialog .picklist button >> nth=0")
              and await admin.locator("dialog.pickdialog .picklist button >> nth=0 >> .badge:has-text('Mine')").count() == 1)
        await admin.click("dialog.pickdialog .picklist button >> nth=0")
        await admin.wait_for_selector(".restcard:has-text('Test Kitchen') details.collection summary:has-text('1 recipe')", timeout=10000)
        copy = next((r for r in fake.recipes.values() if r.get("restaurant_id") == tk["id"]), None)
        check("the admin can add their own recipe to a restaurant's collection",
              copy and copy["scope"] == "restaurant" and copy["title"] == "House Chimichurri" and copy["body"].get("ings") and copy["body"].get("dir"), copy and copy["title"])
        check("and it is listed on the restaurant's card, still open", await admin.locator(".restcard:has-text('Test Kitchen') details[open] .asks li").count() == 1)
        fake.recipes.pop("mine1", None)            # later checks count private recipes
        tk["trial_ends_at"] = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        await admin.reload()
        await open_card(admin, "Test Kitchen")
        check("an ended trial is shown on the card", "Trial ended" in await admin.inner_text(".restcard:has-text('Test Kitchen')"))
        await admin.click(".restcard:has-text('Test Kitchen') button:has-text('Start 14 more days')")
        await admin.wait_for_timeout(600)
        check("and the admin can start it again", fake.on_plan(tk) and "14 days left" in await admin.inner_text(".restcard:has-text('Test Kitchen')"))
        await admin.click(".restcard:has-text('Test Kitchen') details.collection summary")
        await admin.click(".restcard:has-text('Test Kitchen') .asks button.icon-btn")
        await admin.click("dialog[open] button:has-text('Take it out')")
        await admin.wait_for_selector(".restcard:has-text('Test Kitchen') details.collection summary:has-text('0 recipes')")
        check("a recipe can be taken out of a collection", not any(r.get("restaurant_id") == tk["id"] for r in fake.recipes.values()))
        await admin.click(".restcard:has-text('Test Kitchen') button.danger")
        await admin.click("dialog[open] button:has-text('Delete restaurant')")
        await admin.wait_for_selector("h1:has-text('Admin tools')")
        await admin.wait_for_timeout(500)

        student_code, student_link = await make_link(admin, "student")
        check("invite link shows a QR code", await admin.locator("section .invite-share .qr svg path").count() == 1)
        check("invite link opens the join page", student_link.endswith("#/join/" + student_code))
        rest_code, _ = await make_link(admin, "owner", "Maple Street Grill")
        check("invite codes are generated", student_code.startswith("CODE") and rest_code != student_code
              and fake.invites[rest_code]["member_role"] == "owner")
        await admin.click("section button:has-text('Show big QR')")
        await admin.wait_for_selector("dialog.qrdialog[open] svg")
        await admin.screenshot(path="/tmp/cloud_bigqr.png")
        await admin.click("dialog.qrdialog[open] button:has-text('Done')")

        # email an invite
        await admin.select_option("select[aria-label='Who are you inviting']", "student")
        await admin.fill("input[aria-label='Their name']", "Kim")
        await admin.fill("input[aria-label='Their email']", "kim@example.com")
        await admin.click("button:has-text('Send invite email')")
        await admin.wait_for_selector("text=Sent. Kim will get an email")
        check("admin can email an invite", fake.sent and fake.sent[-1]["email"] == "kim@example.com" and fake.sent[-1]["name"] == "Kim"
              and fake.sent[-1]["app_url"].startswith("http"))
        await admin.fill("input[aria-label='Their email']", "chef@example.com")
        await admin.click("button:has-text('Send invite email')")
        await admin.wait_for_selector(".note:has-text('already has an account')")
        check("emailing someone who already has an account is explained", True)
        await admin.screenshot(path="/tmp/cloud_admin_invite.png", full_page=True)
        fake.recipes["coll1"] = dict(id="coll1", owner_id=fake.users["chef@example.com"]["id"], scope="restaurant", restaurant_id=rid, status="approved",
                                     title="Maple House Vinaigrette", categories=["Salad dressings"], author_name=None, review_note=None, source_recipe_id=None,
                                     body=dict(tags=[], yq="2", yu="cups", yr="2 cups", dir="Whisk.", ings=[["1", "1 cup", "cup", "olive oil", ""]]))

        # ---- student
        sctx, st = await new_page(b, fake)
        await st.goto(URL + "#/settings")
        await st.wait_for_selector("button[role=tab]:has-text('New account')")
        await st.click("button[role=tab]:has-text('New account')")
        await st.fill("input[aria-label='Your name']", "Sam")
        await st.fill("input[type=email]", "sam@example.com")
        await st.fill("input[type=password]", "samspass99")
        await st.fill("input[aria-label='Invite code']", "BADCODE1")
        await st.click("button[type=submit]")
        await st.wait_for_selector(".note:has-text('invite code')")
        check("bad invite code is explained", True)
        # ...then opens the link they were sent
        await st.goto(student_link)
        await st.wait_for_selector("h1:has-text('You’re invited!')")
        check("join link fills in the invite code", await st.locator(".okline:has-text('" + student_code + "')").count() == 1
              and await st.locator("input[aria-label='Invite code']").count() == 0)
        await st.screenshot(path="/tmp/cloud_join.png", full_page=True)
        await st.fill("input[aria-label='Your name']", "Sam")
        await st.fill("input[type=email]", "sam@example.com")
        await st.fill("input[aria-label=Password]", "samspass99")
        await st.click("button.showpw")
        check("password can be shown", await st.get_attribute("input[aria-label=Password]", "type") == "text")
        await st.click("button[type=submit]")
        check("sign-up shows a welcome dialog", "Welcome, Sam!" in await close_dialog(st))
        await st.wait_for_selector("text=Sign out")
        check("student creates an account with a code", "sam@example.com" in fake.users)

        await st.goto(URL + "#/")
        await st.wait_for_selector(".chips.src")
        check("source chips appear when signed in", await st.locator(".chips.src .chip").count() >= 4)
        check("restaurant collection is hidden from a non-member", await st.locator(".rc:has-text('Maple House')").count() == 0)

        async def add_recipe(page, title):
            await page.goto(URL + "#/new")
            await page.fill("input[aria-label=Title]", title)
            await page.fill("input[aria-label=Amount]", "2")
            await page.fill("input[aria-label=Unit]", "cup")
            await page.fill("input[aria-label=Ingredient]", "flour")
            await page.fill("textarea", "Mix.")
            await page.click("button:has-text('Save')")
            await page.wait_for_timeout(700)

        await add_recipe(st, "Sam Secret Biscuits")
        check("new recipe is saved in the account", sum(r["scope"] == "private" for r in fake.recipes.values()) == 1)
        check("recipe page opens after saving", "Sam Secret Biscuits" in await st.inner_text("h1"))
        await add_recipe(st, "Sam Second")
        await add_recipe(st, "Sam Third")
        check("free limit message is shown, nothing lost silently", await st.locator("h1:has-text('New recipe')").count() == 1
              and sum(r["scope"] == "private" for r in fake.recipes.values()) == 2)

        await st.goto(URL + "#/")
        await st.click(".chips.src .chip:has-text('My recipes')")
        await st.fill("input[type=search]", "Secret")
        await st.wait_for_timeout(300)
        check("My recipes filter shows the account recipe", await st.locator(".rc:has-text('Sam Secret Biscuits')").count() == 1)
        await st.click(".rc:has-text('Sam Secret Biscuits')")
        await st.wait_for_selector("button:has-text('Share with the Community')")
        st.once("dialog", lambda d: d.accept())
        await st.click("button:has-text('Share with the Community')")
        await st.wait_for_selector("dialog[open]")
        check("rights wording is shown before sharing", "right to share" in (await st.inner_text("dialog[open]")))
        await st.click("dialog[open] button:has-text('Share')")
        await st.wait_for_selector("text=Withdraw from Community")
        pend = [r for r in fake.recipes.values() if r["scope"] == "community"]
        check("sharing creates a pending copy", len(pend) == 1 and pend[0]["status"] == "pending" and pend[0]["author_name"] == "Sam")

        # ---- admin approves
        await admin.reload()
        await admin_tab(admin, "Community")
        await admin.wait_for_selector("text=Sam Secret Biscuits")
        check("admin sees the submission with the author", await admin.locator("text=Shared by Sam").count() == 1)
        await admin.click("button:has-text('Approve')")
        await admin.wait_for_selector("text=Nothing is waiting for approval")
        check("approval is saved", pend[0]["status"] == "approved")

        # ---- another student sees it in Community
        s2ctx, s2 = await new_page(b, fake)
        fake.add_user("pat@example.com", "patspass99", "Pat", "student")
        await sign_in(s2, "pat@example.com", "patspass99")
        await s2.goto(URL + "#/")
        await s2.wait_for_selector(".chips.src")
        await s2.click(".chips.src .chip:has-text('Community')")
        await s2.wait_for_selector(".rc:has-text('Sam Secret Biscuits')")
        check("approved recipe appears in Community with a badge", await s2.locator(".rc:has-text('Sam Secret Biscuits') .badge:has-text('Community')").count() == 1)
        await s2.click(".rc:has-text('Sam Secret Biscuits')")
        await s2.wait_for_selector(".credit:has-text('Shared by Sam')")
        check("author is credited", True)
        check("others cannot edit a community recipe", await s2.locator("a[aria-label='Edit recipe']").count() == 0)
        check("others cannot see Sam's private recipes", "Sam Second" not in await (await s2.request.get(URL)).text())
        await s2.goto(URL + "#/")
        await s2.fill("input[type=search]", "Sam Second")
        await s2.wait_for_timeout(300)
        check("private recipes of others never listed", await s2.locator(".rc").count() == 0)

        # ---- restaurant staff
        await admin.reload()
        await admin.wait_for_selector(".admintabs")
        code2, link2 = await make_link(admin, "staff", "Maple Street Grill")
        rctx, rs = await new_page(b, fake)
        await rs.goto(URL + "#/settings")
        await rs.click("button[role=tab]:has-text('New account')")
        await rs.fill("input[aria-label='Your name']", "Rae")
        await rs.fill("input[type=email]", "rae@maple.test")
        await rs.fill("input[type=password]", "raespass99")
        await rs.fill("input[aria-label='Invite code']", code2)
        await rs.click("button[type=submit]")
        await close_dialog(rs, "Welcome, Rae")
        await rs.wait_for_selector("text=Sign out")
        check("restaurant staff account shows the restaurant and plan", await rs.locator(".stat:has-text('Maple Street Grill')").count() == 1)
        await rs.goto(URL + "#/")
        await rs.wait_for_selector(".chips.src")
        await rs.fill("input[type=search]", "Vinaigrette")
        await rs.wait_for_timeout(300)
        check("staff see the restaurant collection", await rs.locator(".rc:has-text('Maple House Vinaigrette') .badge:has-text('Maple Street Grill')").count() == 1)
        await rs.click(".rc:has-text('Maple House')")
        await rs.wait_for_selector(".credit:has-text('collection')")
        check("collection recipes are read only for staff", await rs.locator("a[aria-label='Edit recipe']").count() == 0)
        await rs.fill("input[aria-label='Multiplier']", "2")
        await rs.wait_for_timeout(200)
        check("collection recipe scales", "2" in await rs.inner_text(".ing"))

        # lapsed subscription hides the collection
        fake.restaurants[rid]["subscription_status"] = "canceled"
        await rs.goto(URL + "#/")
        await rs.reload()
        await rs.wait_for_selector(".rc")
        await rs.fill("input[type=search]", "Vinaigrette")
        await rs.wait_for_timeout(500)
        check("lapsed subscription hides the collection", await rs.locator(".rc:has-text('Maple House')").count() == 0)

        # ---- offline: cached account data still opens
        fake.online = False
        await st.goto(URL + "#/")
        await st.reload()
        await st.wait_for_selector(".rc")
        await st.fill("input[type=search]", "Secret")
        await st.wait_for_timeout(400)
        check("account recipes open offline from the cache", await st.locator(".rc:has-text('Sam Secret Biscuits')").count() >= 1)
        fake.online = True

        # ---- stars follow the person to another device
        await st.goto(URL + "#/")
        await st.fill("input[type=search]", "Sam Secret Biscuits")
        await st.wait_for_timeout(300)
        await st.click(".rows .star >> nth=0")
        await st.wait_for_timeout(1500)
        sam_id = fake.users["sam@example.com"]["id"]
        check("a starred recipe is saved to the account", len(fake.user_data.get(sam_id, {}).get("stars", [])) == 1)
        dctx, dev2 = await new_page(b, fake)
        await sign_in(dev2, "sam@example.com", "samspass99")
        await dev2.goto(URL + "#/starred")
        await dev2.wait_for_selector(".count")
        await dev2.reload()
        await dev2.wait_for_selector(".rc:has-text('Sam Secret Biscuits')")
        check("stars show up on a second device", "1 starred" in await dev2.inner_text(".count"))
        await dev2.click(".rows .star >> nth=0")
        await dev2.wait_for_timeout(1500)
        check("removing a star on one device is saved", fake.user_data[sam_id]["stars"] == [])
        await st.reload()
        await st.wait_for_selector(".rc")
        await st.goto(URL + "#/starred")
        await st.reload()
        await st.wait_for_selector(".empty")
        check("and the first device follows", "0 starred" in await st.inner_text(".count") or await st.locator(".rc").count() == 0)

        fake.no_table = True
        await dev2.goto(URL + "#/settings")
        await dev2.reload()
        await dev2.wait_for_selector("text=Could not find the table", timeout=10000)
        check("a missing table is reported in Settings", await dev2.locator("text=Could not find the table").count() == 1)
        fake.no_table = False

        # ---- the meal plan, shopping list, kitchen and collections follow the person too
        await st.goto(URL + "#/plan")
        await st.wait_for_selector(".planday")
        await st.click(".planday >> nth=2 >> .addday")
        await st.fill("dialog.pickdialog input[type=search]", "Sam Secret Biscuits")
        await st.wait_for_timeout(300)
        await st.click("dialog.pickdialog .picklist button >> nth=0")
        await st.goto(URL + "#/shop")
        await st.fill(".addextra input", "Paper towels")
        await st.press(".addextra input", "Enter")
        await st.goto(URL + "#/pantry")
        await st.fill(".addextra input", "flour, eggs")
        await st.press(".addextra input", "Enter")
        await st.wait_for_timeout(1800)
        doc = fake.user_data.get(sam_id, {}).get("planner", {})
        check("the plan, list and kitchen are saved to the account",
              len(doc.get("plan", {}).get("days", {})) == 1 and len(doc.get("shop", {}).get("extras", [])) == 1
              and doc.get("pantry", {}).get("have") == ["flour", "eggs"], doc)
        check("saving them leaves the stars alone", "stars" in fake.user_data[sam_id])
        await dev2.goto(URL + "#/plan")
        await dev2.reload()
        await dev2.wait_for_selector(".planday .shoprecipes:has-text('Sam Secret Biscuits')", timeout=15000)
        check("the plan shows up on a second device", True)
        await dev2.goto(URL + "#/shop")
        await dev2.wait_for_selector(".shoplist")
        check("so does the shopping list", await dev2.locator(".shoplist li.extra:has-text('Paper towels')").count() == 1)
        await dev2.click(".shoplist li.extra .icon-btn")           # take it off on the second device
        await dev2.wait_for_timeout(1800)
        await st.goto(URL + "#/shop")
        await st.reload()
        await st.wait_for_selector(".empty, .shoplist", timeout=15000)
        await st.wait_for_timeout(1500)
        check("a change on the second device comes back to the first", await st.locator("text=Paper towels").count() == 0)

        # ---- ingredient prices follow the person too
        await st.goto(URL + "#/")
        await st.wait_for_selector(".rc")
        await st.fill("input[type=search]", "European Sour Cream Apple Pie")
        await st.wait_for_timeout(500)
        await st.click(".rc >> nth=0")
        await st.wait_for_selector("ul.ing li")
        await st.click("details.costcard > summary")
        await st.fill("input[aria-label='Price of butter']", "4.5")
        await st.wait_for_timeout(1800)
        doc = fake.user_data.get(sam_id, {}).get("planner", {})
        check("prices are saved to the account", doc.get("prices", {}).get("items", {}).get("butter") == {"p": 4.5, "per": "lb"}, doc.get("prices"))
        check("saving prices keeps the plan", len(doc.get("plan", {}).get("days", {})) == 1)
        await dev2.goto(URL + "#/prices")
        await dev2.reload()
        await dev2.wait_for_selector(".pricebook .costline:has-text('butter')", timeout=15000)
        check("prices show up on a second device", await dev2.input_value(".pricebook input[aria-label='Price of butter']") == "4.5")

        fake.no_planner = True
        await st.goto(URL + "#/plan")
        await st.wait_for_selector(".planday")
        await st.click(".planday >> nth=5 >> .addday")
        await st.fill("dialog.pickdialog input[type=text]", "Leftovers")
        await st.click("dialog.pickdialog form button")
        await st.wait_for_timeout(1800)
        await st.reload()
        await st.wait_for_selector(".planday")
        await st.wait_for_selector("text=Not saved to your account yet", timeout=10000)
        check("a database without the planner column is explained, and the plan is kept on the device",
              "add_planner.sql" in await st.inner_text("#app") and await st.locator(".plannote:has-text('Leftovers')").count() == 1)
        fake.no_planner = False

        # ---- recipes made while signed out can be moved into the account
        lctx, loc = await new_page(b, fake)
        await add_recipe(loc, "Offline Only Soup")
        await loc.goto(URL + "#/settings")
        await sign_in(loc, "pat@example.com", "patspass99")
        await loc.wait_for_selector("button:has-text('Move them to my account')")
        await loc.click("button:has-text('Move them to my account')")
        await loc.click("dialog[open] button:has-text('Move')")
        await loc.wait_for_selector("text=Moved 1", timeout=5000) if False else await loc.wait_for_timeout(1200)
        check("on-device recipes move into the account", any(r["title"] == "Offline Only Soup" and r["owner_id"] == fake.users["pat@example.com"]["id"] for r in fake.recipes.values()))
        check("moved recipe card disappears", await loc.locator("button:has-text('Move them to my account')").count() == 0)

        # ---- forgot password
        fctx, fp = await new_page(b, fake)
        await fp.goto(URL + "#/settings")
        await fp.click("button:has-text('Forgot password?')")
        await fp.wait_for_selector("text=Type your email above first")
        await fp.fill("input[type=email]", "pat@example.com")
        await fp.click("button:has-text('Forgot password?')")
        check("forgot password confirms in a dialog", "reset your password is on its way" in await close_dialog(fp, "Check your email"))
        check("forgot password sends the request", ("POST", "/auth/v1/recover") in fake.log)
        pat = fake.users["pat@example.com"]
        rctx2, rec = await new_page(b, fake)
        await rec.goto(URL + f"#access_token=tok-{pat['id']}&refresh_token=r&expires_in=3600&type=recovery")
        await close_dialog(rec, "Choose a new password")
        await rec.wait_for_selector("input[aria-label='New password']")
        check("reset link signs in and opens the new-password box", "#/settings" in rec.url)
        await rec.fill("input[aria-label='New password']", "brandnew123")
        await rec.click("button:has-text('Save password')")
        await rec.wait_for_timeout(500)
        check("new password is saved", pat["pw"] == "brandnew123")
        await close_dialog(rec, "Password changed")

        # ---- arriving from an emailed invite: signed in, asked to choose a password
        kim_id = fake.add_user("kim@example.com", "", "Kim", "student")
        kim = fake.users["kim@example.com"]
        ictx, inv = await new_page(b, fake)
        await inv.goto(URL + f"#access_token=tok-{kim['id']}&refresh_token=r&expires_in=3600&type=invite")
        check("invite email link welcomes them", "Welcome to Jones Ridge Recipes" in await close_dialog(inv))
        await inv.wait_for_selector("text=Choose a password")
        await inv.screenshot(path="/tmp/cloud_invited.png", full_page=True)
        check("no Cancel on the first password", await inv.locator(".card button:has-text('Cancel')").count() == 0)
        await inv.fill("input[aria-label='New password']", "kimspass99")
        await inv.click("button:has-text('Save password')")
        check("choosing the first password confirms how to sign in next time", "Next time, sign in with" in await close_dialog(inv, "all set"))  # the fake token has no email in it
        check("invited person's password is saved", kim["pw"] == "kimspass99")
        await inv.goto(URL + "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired")
        await inv.reload()
        check("an expired email link is explained", "expired or was already used" in await close_dialog(inv, "didn’t work"))

        # ---- withdraw + sign out
        await st.goto(URL + "#/")
        await st.fill("input[type=search]", "Secret")
        await st.wait_for_timeout(300)
        await st.click(".rc:has-text('Sam Secret Biscuits') >> nth=0")
        await st.wait_for_selector("button:has-text('Withdraw from Community')")
        await st.click("button:has-text('Withdraw from Community')")
        await st.click("dialog[open] button:has-text('Withdraw')")
        await st.wait_for_selector("button:has-text('Share with the Community')")
        check("author can withdraw", not any(r["scope"] == "community" for r in fake.recipes.values()))
        await st.goto(URL + "#/settings")
        await st.click("button:has-text('Sign out')")
        await st.wait_for_selector("input[type=email]")
        await st.goto(URL + "#/")
        await st.wait_for_selector(".rc")
        check("signed-out app hides source chips and account recipes", await st.locator(".chips.src:not([hidden])").count() == 0)
        await st.screenshot(path="/tmp/cloud_signedout.png")
        check("admin page refuses non-admins", True)
        await st.goto(URL + "#/admin")
        await st.wait_for_selector("text=This page is for the administrator")

        # ---- vegan links and import from a web page (admin has no free-plan limit)
        await admin.goto(URL + "#/")
        await admin.goto(URL + "#/links/noracooks")
        await admin.wait_for_selector("h1:has-text('Nora Cooks')")
        links = await admin.eval_on_selector_all(".rows a.rc", "els => els.map(a => [a.href, a.target, a.rel])")
        check("Nora Cooks list links out to her site in a new tab",
              len(links) > 40 and all(h.startswith("https://www.noracooks.com/?s=") and t == "_blank" and "noopener" in r for h, t, r in links))
        check("Nora Cooks list credits her", await admin.locator("text=These recipes belong to Nora Taylor").count() == 1)
        await admin.fill("input[type=search]", "lasagna")
        await admin.wait_for_timeout(200)
        check("Nora Cooks list can be searched", await admin.locator(".rows a.rc").count() == 1)
        await admin.goto(URL + "#/new")
        check("Add page offers import from a web page", await admin.locator("a:has-text('Import from a web page or a photo')").count() == 1)
        await admin.click("a:has-text('Import from a web page or a photo')")
        await admin.fill("input[aria-label='Recipe page address']", "example.com/test-lentil-soup/")
        await admin.click("button:has-text('Get recipe')")
        await admin.wait_for_selector("h1:has-text('Check and save')")
        check("imported recipe opens in the editor with the credit filled in",
              await admin.input_value("input[aria-label='Recipe by']") == "Pat Example"
              and await admin.input_value("input[aria-label='Link to the original']") == "https://example.com/test-lentil-soup/"
              and await admin.input_value("input[aria-label=Title]") == "Test Lentil Soup")
        await admin.click("button:has-text('Save')")
        await admin.wait_for_selector(".srccredit")
        saved = [r for r in fake.recipes.values() if r["title"] == "Test Lentil Soup"]
        check("imported recipe is saved privately with its credit",
              len(saved) == 1 and saved[0]["scope"] == "private" and saved[0]["body"]["src"]["author"] == "Pat Example")
        check("recipe page shows the credit and a link to the original",
              "Recipe by Pat Example" in await admin.inner_text(".srccredit")
              and await admin.get_attribute(".srccredit a", "href") == "https://example.com/test-lentil-soup/")
        await admin.click("button:has-text('Share link')")
        await admin.wait_for_selector("dialog.sharedialog input.link")
        check("an imported recipe shares the link to the original, not its text",
              await admin.input_value("dialog.sharedialog input.link") == "https://example.com/test-lentil-soup/"
              and "#/s/" not in await admin.input_value("dialog.sharedialog input.link"))
        await admin.click("dialog.sharedialog button:has-text('Done')")
        check("imported recipe cannot be shared to Community",
              await admin.locator("button:has-text('Share with the Community')").count() == 0
              and await admin.locator("text=stays in your private recipes").count() == 1)
        await admin.screenshot(path="/tmp/cloud_imported.png", full_page=True)

        # ---- share it as a link card
        admin.once("dialog", lambda d: d.accept())
        await admin.click("button:has-text('Share a link to the Community')")
        await admin.wait_for_selector("dialog[open]")
        check("link sharing explains nothing is copied", "None of the recipe" in await admin.inner_text("dialog[open]"))
        await admin.click("dialog[open] button:has-text('Share link')")
        await admin.wait_for_selector("text=A link to this recipe is waiting for approval")
        card = [r for r in fake.recipes.values() if r["scope"] == "community" and r["body"].get("kind") == "link"]
        check("link card goes to Community with no recipe text", len(card) == 1 and card[0]["body"]["dir"] == "" and card[0]["body"]["ings"] == []
              and card[0]["body"]["src"]["url"] == "https://example.com/test-lentil-soup/")
        await admin.goto(URL + "#/admin/community")
        await admin.wait_for_selector("text=Link card: Pat Example")
        check("admin sees the original link when reviewing a link card",
              await admin.get_attribute("a:has-text('Check the original')", "href") == "https://example.com/test-lentil-soup/")
        await admin.goto(URL + f"#/r/{card[0]['id']}")
        await admin.wait_for_selector(".linkcard")
        check("link card page opens the original website",
              await admin.get_attribute(".linkcard a", "href") == "https://example.com/test-lentil-soup/"
              and await admin.locator("h2:has-text('Ingredients')").count() == 0)
        await admin.screenshot(path="/tmp/cloud_linkcard.png", full_page=True)

        # ---- make my own version
        imported = next(r for r in fake.recipes.values() if r["title"] == "Test Lentil Soup" and r["scope"] == "private")
        await admin.goto(URL + f"#/r/{imported['id']}")
        await admin.click("button:has-text('Make my own version')")
        await admin.wait_for_selector("h1:has-text('Make your own version')")
        check("own version starts with the ingredients and an empty method",
              await admin.input_value("input[aria-label=Title]") == "Test Lentil Soup (my version)"
              and await admin.input_value("textarea") == "" and await admin.locator("details.original li").count() == 2)
        await admin.fill("textarea", "Simmer. Serve.")
        await admin.click("button:has-text('Save')")
        await admin.wait_for_selector("text=too close to the original wording")
        check("copying the original method is refused", not any(r["title"].endswith("(my version)") for r in fake.recipes.values()))
        await admin.fill("textarea", "Cook the lentils gently in plenty of water until soft, about half an hour.\nTaste, adjust the salt and ladle into bowls.")
        await admin.click("button:has-text('Save')")
        await admin.wait_for_selector("h1:has-text('(my version)')")
        mine = [r for r in fake.recipes.values() if r["title"].endswith("(my version)")]
        check("own version is saved with an Adapted from credit and no imported-source tag",
              len(mine) == 1 and mine[0]["body"]["adapted"]["url"] == "https://example.com/test-lentil-soup/" and "src" not in mine[0]["body"])
        check("own version shows its Adapted from credit", "Adapted from Pat Example" in await admin.inner_text(".srccredit"))
        check("own version can be shared with the Community", await admin.locator("button:has-text('Share with the Community')").count() == 1)
        await admin.screenshot(path="/tmp/cloud_adapted.png", full_page=True)

        # ---- asking for an invite, and a used-up link
        qctx, q = await new_page(b, fake)
        await q.goto(URL + "#/join/" + code2)
        await q.wait_for_selector("h1:has-text('can’t be used')")
        check("a used-up invite link explains itself and offers a request form",
              "already been used" in await q.inner_text(".note") and await q.locator("button:has-text('Ask for an invite')").count() == 1)
        await q.goto(URL + "#/settings")
        await q.click("button[role=tab]:has-text('Request')")
        await q.fill("input[aria-label='Your name']", "Dee")
        await q.fill("input[aria-label='Your email']", "Dee@Example.com")
        await q.select_option("select[aria-label='I am']", "student")
        await q.fill("textarea[aria-label=Note]", "Tuesday class")
        await q.click("button:has-text('Ask for an invite')")
        check("asking for an invite shows a confirmation", "Request sent" in await close_dialog(q))
        check("the request reaches the admin's list", any(r["email"] == "dee@example.com" and r["note"] == "Tuesday class" for r in fake.requests.values()))
        check("the admin is emailed about a new request", fake.notified == ["dee@example.com"])
        await q.screenshot(path="/tmp/cloud_request.png", full_page=True)
        await admin.goto(URL + "#/admin/invites")
        await admin.wait_for_selector("h2:has-text('Invite requests (1)')")
        check("the Invites tab shows how many are waiting", (await admin.inner_text(".admintab:has-text('Invites') .count")).strip() == "1")
        await admin.click("button:has-text('Send student invite')")
        await admin.wait_for_selector("text=Nobody is waiting for an invite")
        # ---- People: one line each, searchable, opening for the details
        await admin_tab(admin, "People")
        await admin.wait_for_selector("details.person")
        students = sum(1 for x in fake.users.values() if x["role"] == "student")
        check("People lists students one line each, with a count in the menu",
              await admin.locator("details.person").count() == students and f"Students ({students})" in await admin.inner_text("select[aria-label='Show']"))
        await admin.screenshot(path="/tmp/cloud_admin_people.png")
        await admin.fill("input[aria-label='Search people']", "pat@")
        check("People can be searched by email", await admin.locator("details.person").count() == 1)
        check("a person's details are folded away until opened", not await admin.locator("details.person button:has-text('Remove')").is_visible())
        await admin.click("details.person summary")
        check("opening a person shows their details and Remove", await admin.locator("details.person button:has-text('Remove')").is_visible()
              and "private recipe" in await admin.inner_text("details.person"))
        await admin_tab(admin, "Invites")
        check("admin can answer a request with an emailed invite",
              fake.sent[-1]["email"] == "dee@example.com" and fake.sent[-1]["request_id"] and
              all(r["status"] == "invited" for r in fake.requests.values()))

        # ---- open sign-up switch
        await admin.goto(URL + "#/admin/invites")
        await admin.wait_for_selector("text=Off: people need an invite")
        await admin.click("input[aria-label='Open sign-up']")
        await admin.wait_for_selector("dialog[open]")
        check("opening sign-up asks first", "Anyone who finds the app" in await admin.inner_text("dialog[open]"))
        await admin.click("dialog[open] button:has-text('Open sign-up')")
        await admin.wait_for_selector("text=On: anyone can create")
        check("admin can open sign-up", fake.open_signup is True)
        octx, o = await new_page(b, fake)
        await o.goto(URL + "#/settings")
        await o.wait_for_selector("button[role=tab]:has-text('New account')")
        # the form repaints once the app has asked whether sign-up is open; wait for that, however slow the machine
        await o.wait_for_function("![...document.querySelectorAll('button[role=tab]')].some(b => b.textContent.includes('Request'))", timeout=15000)
        await o.wait_for_timeout(300)
        check("with open sign-up there is no Request tab", await o.locator("button[role=tab]:has-text('Request')").count() == 0)
        await o.click("button[role=tab]:has-text('New account')")
        await o.fill("input[aria-label='Your name']", "Val")
        await o.fill("input[type=email]", "val@example.com")
        await o.fill("input[aria-label=Password]", "valspass99")
        await o.click("button[type=submit]")
        check("with open sign-up anyone can join without a code", "Welcome, Val!" in await close_dialog(o) and "val@example.com" in fake.users)
        await admin.click("input[aria-label='Open sign-up']")
        await admin.click("dialog[open] button:has-text('Close sign-up')")
        await admin.wait_for_selector("text=Off: people need an invite")
        check("admin can close sign-up again", fake.open_signup is False)

        # ---- meal prep clients: the chef plans a week, the client approves it dish by dish
        await admin.goto(URL + "#/settings")
        await admin.wait_for_selector("a:has-text('Meal prep clients')")
        await admin.click("a:has-text('Meal prep clients')")
        await admin.wait_for_selector(".addclient")
        await admin.fill("input[aria-label='Client name']", "Anna Lee")
        await admin.fill("input[aria-label='Client email']", "Anna@Example.com")
        await admin.select_option(".addclient select", "couple")
        await admin.click(".addclient button[type=submit]")
        await admin.wait_for_selector("text=About this client")
        check("a new client starts on the plan from the website", "Couple · 5 dishes × 2 servings · $185 a week" in await admin.inner_text("#app"))
        await admin.check(".allergybox label:has-text('Fish') input")
        await admin.fill("input[aria-label='Foods to avoid']", "no mushrooms")
        await admin.fill("textarea[aria-label='Private notes']", "Gate code 1234")
        await admin.click("button:has-text('Save') >> nth=0")
        await admin.wait_for_selector("text=Allergies: Fish")
        client_row = next(iter(fake.cdb["clients"].values()))
        check("allergies and private notes are saved", client_row["allergens"] == ["Fish"] and fake.cdb["client_notes"][client_row["id"]]["notes"] == "Gate code 1234")

        async def add_dish(page, search):
            await page.click("button:has-text('Add a dish')")
            await page.fill("dialog.pickdialog input[type=search]", search)
            await page.wait_for_timeout(300)
            await page.click("dialog.pickdialog .picklist button >> nth=0")
            await page.wait_for_timeout(900)

        await admin.click("button:has-text('Plan this week')")
        await admin.wait_for_selector("button:has-text('Add a dish')")
        await add_dish(admin, "Hearty Russian Beet Soup")
        await add_dish(admin, "salmon")
        check("two dishes are on the draft menu", await admin.locator(".mealcard").count() == 2 and len(fake.cdb["client_meals"]) == 2)
        soup = next(m for m in fake.cdb["client_meals"].values() if "Beet" in m["title"])
        fish = next(m for m in fake.cdb["client_meals"].values() if "Beet" not in m["title"])
        check("a dish is stored as names only: no amounts, no method", soup["ingredients"] and all(not any(ch.isdigit() for ch in n) for n in soup["ingredients"])
              and "dir" not in soup and soup["servings"] == 2, soup)
        check("the recipe link is kept apart from what the client can read", fake.cdb["client_meal_private"][soup["id"]]["recipe_id"] and "recipe_id" not in soup)
        check("fish is suggested as an allergen and flagged for this client", "Fish" in fish["allergens"] and "Contains Fish" in await admin.inner_text("#app"), fish["allergens"])
        # one dish from several recipes: a side goes onto the soup as a chip, and comes off again
        check("a one-recipe dish shows its recipe and a way to add a side",
              await admin.locator(".mealcard >> nth=0 >> .partchip").count() == 1
              and await admin.locator(".mealcard >> nth=0 >> button.addpart:has-text('Add a side or sauce')").count() == 1)
        soup_ings = len(soup["ingredients"])
        await admin.click(".mealcard >> nth=0 >> button.addpart")
        await admin.fill("dialog.pickdialog input[type=search]", "rice")
        await admin.wait_for_timeout(300)
        await admin.click("dialog.pickdialog .picklist button >> nth=0")
        await admin.wait_for_selector(".mealcard >> nth=0 >> .partchip >> nth=1", timeout=10000)
        parts = fake.cdb["client_meal_private"][soup["id"]].get("parts") or []
        check("a side is added to the same dish, not as a new one",
              len(fake.cdb["client_meals"]) == 2 and len(parts) == 2 and parts[0]["recipe_id"] == fake.cdb["client_meal_private"][soup["id"]]["recipe_id"], parts)
        check("the dish name and ingredients take in the side",
              " with " in soup["title"] and len(soup["ingredients"]) > soup_ings and "Add a recipe" in await admin.inner_text(".mealcard >> nth=0 >> .dishparts"), soup["title"])
        check("which recipes make the dish stays off what the client reads", "parts" not in soup)
        await admin.screenshot(path="/tmp/cloud_dish_parts.png", full_page=False)
        await admin.click(".mealcard >> nth=0 >> .partchip >> nth=1 >> button.chipx")
        await admin.wait_for_timeout(900)
        check("a side can be taken out again", (fake.cdb["client_meal_private"][soup["id"]].get("parts") or []) == [] and " with " not in soup["title"]
              and len(soup["ingredients"]) == soup_ings, soup["title"])
        await admin.fill(".mealcard >> nth=0 >> textarea[aria-label=Description]", "A deep red soup, lighter than it looks.")
        await admin.fill(".mealcard >> nth=0 >> input[aria-label=Reheating]", "Stovetop until steaming")
        await admin.click(".mealcard >> nth=0 >> button:has-text('Save this meal')")
        await admin.wait_for_timeout(900)
        await admin.click("button:has-text('Send to Anna Lee')")
        await admin.wait_for_selector("dialog[open]")
        check("sending a dish with their allergen asks first", "allergic" in await admin.inner_text("dialog[open]"))
        await admin.click("dialog[open] button:has-text('Send anyway')")
        await admin.wait_for_selector("button:has-text('Finish this menu')")
        check("the menu is sent", next(iter(fake.cdb["client_menus"].values()))["status"] == "sent")
        await admin.screenshot(path="/tmp/cloud_client_menu_chef.png", full_page=True)

        # ---- the client's own page (jonesridgekitchen.com/my-meals/; web/portal/ here)
        PORTAL = URL + "portal/"
        actx, anna = await new_page(b, fake)
        await anna.goto(PORTAL)
        await anna.wait_for_selector("#jrk-portal .jrk-tabs")
        check("the client page opens signed out with no recipe library in sight",
              await anna.locator("#tabs").count() == 0 and "Recipe" not in await anna.inner_text("#jrk-portal"))
        await anna.click(".jrk-tabs button:has-text('First time here')")
        await anna.fill("#jrk-portal input[aria-label='Your name']", "Stranger")
        await anna.fill("#jrk-portal input[aria-label=Email]", "stranger@example.com")
        await anna.fill("#jrk-portal input[aria-label=Password]", "strangerpass1")
        await anna.click("#jrk-portal button[type=submit]")
        await anna.wait_for_selector("text=don’t have a meal prep plan for that email")
        check("an email with no plan cannot set up a login", "stranger@example.com" not in fake.users)
        await anna.fill("#jrk-portal input[aria-label='Your name']", "Anna Lee")
        await anna.fill("#jrk-portal input[aria-label=Email]", "anna@example.com")
        await anna.fill("#jrk-portal input[aria-label=Password]", "annapass99")
        await anna.click("#jrk-portal button[type=submit]")
        await anna.wait_for_selector("#jrk-portal .jrk-dish", timeout=15000)
        check("the client sets up their own login with the email on file, and it links to their plan",
              client_row["user_id"] == fake.users["anna@example.com"]["id"] and fake.users["anna@example.com"]["meta"].get("portal") == "meal-prep")
        page_text = await anna.inner_text("#jrk-portal")
        check("the client sees the dishes with ingredients, nutrition and allergens",
              "Hello, Anna" in page_text and "Ingredients:" in page_text and "A deep red soup" in page_text and "Stovetop until steaming" in page_text)
        check("the client is warned about their own allergen", "which is on your allergy list" in page_text)
        check("the client never sees the method or the recipe link", "Open the recipe" not in page_text and await anna.locator("#jrk-portal a[href*='#/r/']").count() == 0)
        got = await anna.evaluate("""async () => {
          const s = JSON.parse(localStorage.getItem('recipelib.session'));
          const get = (p) => fetch('https://x.supabase.co/rest/v1/' + p, { headers: { Authorization: 'Bearer ' + s.access_token } }).then((r) => r.json());
          return { priv: await get('client_meal_private?select=*'), notes: await get('client_notes?select=*'), templates: await get('client_menu_templates?select=*') };
        }""")
        check("asking the server directly gives a client nothing private", got == {"priv": [], "notes": [], "templates": []}, got)
        await anna.click(".jrk-dish >> nth=0 >> button:has-text('Approve')")
        await anna.wait_for_selector(".jrk-dish >> nth=0 >> button:has-text('✓ Approved')")
        await anna.click(".jrk-dish >> nth=1 >> button:has-text('Swap this')")
        await anna.fill("dialog.jrk-dialog input", "No fish please, chicken instead")
        await anna.click("dialog.jrk-dialog button[type=submit]")
        await anna.wait_for_selector("text=You asked: No fish please")
        check("approve and swap answers are saved", soup["status"] == "approved" and fish["status"] == "swap" and fish["client_note"] == "No fish please, chicken instead")
        await anna.click(".jrk-dish >> nth=0 >> .jrk-heart")
        await anna.wait_for_selector(".jrk-dish >> nth=0 >> .jrk-heart[aria-pressed=true]")
        await anna.fill("input[aria-label='Ask for a dish']", "Shrimp and grits")
        await anna.press("input[aria-label='Ask for a dish']", "Enter")
        await anna.wait_for_selector("text=with Joseph")
        check("a favourite and a request are saved", len(fake.cdb["client_favorites"]) == 1 and [r["title"] for r in fake.cdb["client_requests"].values()] == ["Shrimp and grits"])
        await anna.check(".jrk-checks label:has-text('Sesame') input")
        await anna.click(".jrk-card:has-text('Allergies and foods to avoid') button:has-text('Save')")
        await anna.wait_for_timeout(1200)
        check("a client can add to their own allergies", client_row["allergens"] == ["Fish", "Sesame"], client_row["allergens"])
        await anna.screenshot(path="/tmp/cloud_client_meals.png", full_page=True)
        await anna.reload()
        await anna.wait_for_selector(".jrk-dish")
        check("the client stays signed in on their page", "Hello, Anna" in await anna.inner_text("#jrk-portal"))
        bctx, olda = await new_page(b, fake)
        await olda.goto(URL + "#/meals")
        await olda.wait_for_selector("a:has-text('Go to my meals')")
        check("the old My meals link in the app points to the website", await olda.get_attribute("a:has-text('Go to my meals')", "href") == "https://jonesridgekitchen.com/my-meals/")

        await admin.reload()
        await admin.wait_for_selector(".mealcard")
        chef_text = (await admin.inner_text("#app")).lower()      # labels are styled in capitals
        check("the chef sees the answers and the swap note", "swap requested" in chef_text and "no fish please, chicken instead" in chef_text and "1 approved, 1 to swap" in chef_text, chef_text[:1500])
        menu_row = next(iter(fake.cdb["client_menus"].values()))
        await admin.goto(URL + f"#/prep/{menu_row['week_start']}")
        await admin.wait_for_selector(".prep li, .empty")
        prep_text = (await admin.inner_text("#app")).lower()
        check("the prep sheet lists approved dishes and what is still waiting", "beet soup" in prep_text and "2 portions" in prep_text and "asked to swap" in prep_text and "$185 in fees" in prep_text, prep_text[:900])
        await admin.goto(URL + f"#/labels/{client_row['id']}/{menu_row['id']}")
        await admin.wait_for_selector(".foodlabel")
        label = await admin.inner_text(".foodlabel >> nth=0")
        check("labels carry the dish, client, reheating and allergens", "Beet Soup" in label and "Anna Lee" in label and "Reheat: Stovetop until steaming" in label and ("Contains:" in label or "No major allergens" in label), label)
        await admin.goto(URL + f"#/clients/{client_row['id']}")
        await admin.wait_for_selector("text=They asked for")
        check("the chef sees the request and the favourite", "Shrimp and grits" in await admin.inner_text("#app"))
        await admin.click(".asks button:has-text('Planned')")
        await admin.wait_for_timeout(900)
        check("a request can be marked as planned", next(iter(fake.cdb["client_requests"].values()))["status"] == "planned")
        await admin.goto(URL + f"#/clients/{client_row['id']}/{menu_row['id']}")
        await admin.wait_for_selector("button:has-text('Finish this menu')")
        await admin.click("button:has-text('Save as a reusable week')")
        await admin.fill("dialog.askdialog input", "Couple week one")
        await admin.click("dialog.askdialog button[type=submit]")
        await admin.wait_for_timeout(900)
        check("a week can be saved to reuse", [t["name"] for t in fake.cdb["client_menu_templates"].values()] == ["Couple week one"])
        await admin.click("button:has-text('Finish this menu')")
        await admin.click("dialog[open] button:has-text('Finish menu')")
        await admin.wait_for_selector("button:has-text('Reopen')")

        await anna.reload()
        await anna.wait_for_selector("text=What you have had", timeout=15000)
        hist = await anna.inner_text("#jrk-portal")
        check("a finished menu moves to the client's history, without the swapped dish", "No menu waiting" in hist and "Beet Soup" in hist and "Every dish so far" in hist)
        await anna.click(".jrk-dish .jrk-stars button >> nth=4")
        await anna.fill("dialog.jrk-dialog input", "Loved it")
        await anna.click("dialog.jrk-dialog button[type=submit]")
        await anna.wait_for_timeout(1200)
        check("a client can rate a dish they have had", soup.get("rating") == 5 and soup.get("feedback") == "Loved it", (soup.get("rating"), soup.get("feedback")))
        await anna.click(".jrk-dish button:has-text('Have this again') >> nth=0")
        await anna.click("dialog.jrk-dialog button[type=submit]")
        await anna.click(".jrk-who button:has-text('Sign out')")
        await anna.wait_for_selector(".jrk-tabs")
        check("the client can sign out", True)
        await anna.wait_for_timeout(1200)
        check("and ask to have it again", any("Beet" in r["title"] and r["status"] == "open" for r in fake.cdb["client_requests"].values()))

        # ---- restaurant clients on the same page (v0.24)
        fake.restaurants[rid]["subscription_status"] = "active"
        for m in fake.members:
            if m["user_id"] == fake.users["rae@maple.test"]["id"]:
                m["member_role"] = "owner"
        pctx, rae = await new_page(b, fake)
        await rae.goto(PORTAL)
        await rae.wait_for_selector("#jrk-portal .jrk-tabs")
        await rae.fill("#jrk-portal input[aria-label=Email]", "rae@maple.test")
        await rae.fill("#jrk-portal input[aria-label=Password]", "raespass99")
        await rae.click("#jrk-portal button[type=submit]")
        await rae.wait_for_selector("#jrk-portal .jrk-recipes", timeout=15000)
        ptext = await rae.inner_text("#jrk-portal")
        check("restaurant staff see their collection on the client page",
              "Maple Street Grill" in ptext and await rae.locator(".jrk-recipes a:has-text('Maple House Vinaigrette')").count() == 1)
        check("a restaurant-only login has no meal prep section or switcher", "Hello," not in ptext and await rae.locator(".jrk-switch").count() == 0)
        check("other recipes the login can see are not listed", await rae.locator(".jrk-recipes li").count() == 1)
        await rae.fill("#jrk-portal input[aria-label='Search recipes']", "zzz")
        check("search narrows the collection", "No recipes match" in await rae.inner_text(".jrk-recipes"))
        await rae.fill("#jrk-portal input[aria-label='Search recipes']", "olive")
        check("search finds by ingredient", await rae.locator(".jrk-recipes a").count() == 1)
        await rae.click(".jrk-recipes a:has-text('Maple House Vinaigrette')")
        await rae.wait_for_selector(".jrk-recipe")
        rtext = await rae.inner_text(".jrk-recipe")
        check("the full recipe opens: yield, ingredients and method", "Makes 2 cups" in rtext and "1 cup olive oil" in rtext and "Whisk." in rtext)
        await rae.click(".jrk-scale button:has-text('2×')")
        check("a collection recipe scales on the client page", "2 cups olive oil" in await rae.inner_text(".jrk-ings-list"))
        await rae.screenshot(path="/tmp/portal_restaurant_recipe.png", full_page=True)
        await rae.go_back()
        await rae.wait_for_selector(".jrk-recipes")
        check("the browser back button returns to the list", "/coll1" not in rae.url and await rae.locator(".jrk-recipe").count() == 0)

        await rae.click(".jrk-subnav a:has-text('Team')")
        await rae.click("button:has-text('Invite someone')")
        await rae.wait_for_selector(".jrk-invite code")
        invite = await rae.inner_text(".jrk-invite code")
        check("an owner can invite staff from the client page", "?join=CODE" in invite, invite)
        jctx, joe = await new_page(b, fake)
        await joe.goto(invite)
        await joe.wait_for_selector("#jrk-portal input[aria-label='Invite code']")
        check("an invite link opens sign-up with the code filled in", (await joe.input_value("#jrk-portal input[aria-label='Invite code']")).startswith("CODE"))
        await joe.fill("#jrk-portal input[aria-label='Your name']", "Joe Line")
        await joe.fill("#jrk-portal input[aria-label=Email]", "joe@maple.test")
        await joe.fill("#jrk-portal input[aria-label=Password]", "joespass99")
        await joe.click("#jrk-portal button[type=submit]")
        await joe.wait_for_selector("#jrk-portal .jrk-recipes", timeout=15000)
        check("new staff land on their restaurant's recipes",
              any(m["user_id"] == fake.users["joe@maple.test"]["id"] and m["member_role"] == "staff" for m in fake.members)
              and "join=" not in joe.url and not fake.users["joe@maple.test"].get("meta", {}).get("portal"))
        check("staff are not offered invites", await joe.locator(".jrk-subnav a:has-text('Team')").count() == 0
              and await joe.locator("button:has-text('Invite someone')").count() == 0)

        fake.restaurants[rid]["subscription_status"] = "canceled"
        await joe.reload()
        await joe.wait_for_selector("text=Your recipe collection is paused")
        check("a lapsed plan shows a paused message instead of recipes", await joe.locator(".jrk-recipes").count() == 0)
        from datetime import datetime, timedelta, timezone
        fake.restaurants[rid].update(subscription_status="trialing", trial_ends_at=(datetime.now(timezone.utc) + timedelta(days=3, hours=1)).isoformat())
        await joe.reload()
        await joe.wait_for_selector("#jrk-portal .jrk-recipes")
        check("a restaurant on a trial sees its recipes and the days left", "Free trial: 4 days left" in await joe.inner_text("#jrk-portal"))
        fake.restaurants[rid]["trial_ends_at"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        await joe.reload()
        await joe.wait_for_selector("text=Your trial has ended")
        check("an ended trial says so and hides the recipes", await joe.locator(".jrk-recipes").count() == 0)
        fake.restaurants[rid].update(subscription_status="active", trial_ends_at=None)

        # ---- the restaurant's own kitchen (v0.29): add recipes, the chef's stay read-only, costing, help
        K = PORTAL + f"#kitchen/{rid}"
        await rae.goto(K); await rae.reload()
        await rae.wait_for_selector(".jrk-subnav")
        check("a restaurant's page has Recipes, Prep list, Costing and Help tabs, and Team for owners",
              await rae.locator(".jrk-subnav a").all_inner_texts() == ["Recipes", "Prep list", "Costing", "Help", "Team"])
        await rae.click("a:has-text('+ Add a recipe')")
        await rae.wait_for_selector(".jrk-editor")
        await rae.screenshot(path="/tmp/portal_editor.png", full_page=True)
        await rae.fill(".jrk-editor input[aria-label='Recipe name']", "House Salsa")
        await rae.fill(".jrk-editor input[aria-label=Categories]", "Sauces")
        await rae.fill(".jrk-editor input[aria-label=Makes]", "2 quarts")
        await rae.fill(".jrk-editor textarea[aria-label=Ingredients]", "4 lb tomatoes\n1 cup onion, diced\nGarnish:\n1 bunch cilantro")
        await rae.fill(".jrk-editor textarea[aria-label=Method]", "Chop everything.\nMix and chill.")
        await rae.click(".jrk-editor button[type=submit]")
        await rae.wait_for_selector(".jrk-recipe h2:has-text('House Salsa')")
        salsa = next((x for x in fake.recipes.values() if x["title"] == "House Salsa"), None)
        check("an owner can add a recipe to the restaurant", salsa and salsa["scope"] == "restaurant" and salsa["restaurant_id"] == rid
              and salsa["owner_id"] == fake.users["rae@maple.test"]["id"] and len(salsa["body"]["ings"]) == 3 and salsa["body"]["dir"].count("\n") == 1, salsa)
        rtext = await rae.inner_text(".jrk-recipe")
        check("it reads as the team's recipe, with its allergens and an Edit button", "Your team’s recipe" in rtext and "Garnish" in rtext
              and await rae.locator(".jrk-recipe a:has-text('Edit')").count() == 1 and await rae.locator(".jrk-recipe button:has-text('Delete')").count() == 1)
        await rae.click(".jrk-recipe a:has-text('Edit')")
        await rae.wait_for_selector(".jrk-editor")
        check("editing starts from the recipe as it is", "4 lb tomatoes" in await rae.input_value(".jrk-editor textarea[aria-label=Ingredients]")
              and "Garnish:" in await rae.input_value(".jrk-editor textarea[aria-label=Ingredients]"))
        await rae.fill(".jrk-editor input[aria-label='Recipe name']", "House Salsa Roja")
        await rae.click(".jrk-editor button[type=submit]")
        await rae.wait_for_selector(".jrk-recipe h2:has-text('House Salsa Roja')")
        check("and saves the change", salsa["title"] == "House Salsa Roja")
        await rae.goto(K)
        await rae.wait_for_selector(".jrk-recipes")
        check("the team's recipes are marked Ours in the list", await rae.locator(".jrk-recipes li:has-text('House Salsa Roja') .jrk-tag:has-text('Ours')").count() == 1
              and await rae.locator(".jrk-recipes li:has-text('Maple House Vinaigrette') .jrk-tag").count() == 0)
        await rae.click(".jrk-recipes a:has-text('Maple House Vinaigrette')")
        await rae.wait_for_selector(".jrk-recipe")
        check("the chef's recipes can't be changed or deleted by the restaurant",
              "From Jones Ridge Kitchen" in await rae.inner_text(".jrk-recipe") and await rae.locator(".jrk-recipe a:has-text('Edit')").count() == 0
              and await rae.locator(".jrk-recipe button:has-text('Delete')").count() == 0
              and await rae.locator(".jrk-recipe a:has-text('Make our own version')").count() == 1)
        await rae.goto(PORTAL + f"#kitchen/{rid}/edit/coll1")
        await rae.wait_for_selector("text=You can’t change this recipe")
        check("not even from a typed-in address", await rae.locator(".jrk-editor").count() == 0)
        check("and the database refuses it too", not fake.team_can_change(fake.users["rae@maple.test"], fake.recipes["coll1"]))

        # staff: can add and remove their own, not the owner's
        await joe.goto(K); await joe.reload()
        await joe.wait_for_selector(".jrk-recipes")
        await joe.click(".jrk-recipes a:has-text('House Salsa Roja')")
        await joe.wait_for_selector(".jrk-recipe")
        check("staff can't change a recipe the owner added", await joe.locator(".jrk-recipe a:has-text('Edit')").count() == 0)
        await joe.goto(K + "/new")
        await joe.wait_for_selector(".jrk-editor")
        await joe.fill(".jrk-editor input[aria-label='Recipe name']", "Line Slaw")
        await joe.fill(".jrk-editor textarea[aria-label=Ingredients]", "1 head cabbage")
        await joe.click(".jrk-editor button[type=submit]")
        await joe.wait_for_selector(".jrk-recipe h2:has-text('Line Slaw')")
        check("staff can add a recipe", any(x["title"] == "Line Slaw" for x in fake.recipes.values()))
        await joe.click(".jrk-recipe button:has-text('Delete')")
        await joe.click("dialog.jrk-dialog button:has-text('Delete')")
        await joe.wait_for_selector(".jrk-recipes")
        check("and delete the one they added", not any(x["title"] == "Line Slaw" for x in fake.recipes.values()))

        # costing: a shared price book
        await rae.goto(K + "/costing")
        await rae.wait_for_selector("table.jrk-cost")
        await rae.screenshot(path="/tmp/portal_costing.png", full_page=True)
        check("Costing lists every recipe", await rae.locator("table.jrk-cost tbody tr").count() == 2)
        await rae.click("table.jrk-cost a:has-text('House Salsa Roja')")
        await rae.wait_for_selector("table.jrk-costlines")
        await rae.fill("input[aria-label='Price of tomatoes']", "2")
        await rae.press("input[aria-label='Price of tomatoes']", "Tab")
        await rae.wait_for_selector("table.jrk-costlines tfoot:has-text('$8.00')")
        await rae.fill("input[aria-label='Portions per batch']", "16")
        await rae.press("input[aria-label='Portions per batch']", "Tab")
        await rae.wait_for_selector(".jrk-summary:has-text('$0.50')")
        await rae.fill("input[aria-label='Menu price']", "2")
        await rae.press("input[aria-label='Menu price']", "Tab")
        await rae.wait_for_selector(".jrk-summary:has-text('25%')")
        await rae.screenshot(path="/tmp/portal_costing_recipe.png", full_page=True)
        summ = await rae.inner_text(".jrk-summary")
        check("an ingredient price costs the recipe: batch, portion, food cost % and the price at the target",
              "$0.50" in summ and "25%" in summ and "$1.67" in summ, summ)
        book = fake.kitchens.get(rid, {})
        check("the prices are kept for the restaurant", any(v["p"] == 2 and v["per"] == "lb" for v in book.get("items", {}).values())
              and book.get("portions", {}).get(salsa["id"]) == 16 and book.get("menu", {}).get(salsa["id"]) == 2, book)
        # costing is the owner's to share: staff start with none, the owner gives view or edit on the Team tab
        await joe.goto(K + f"/{salsa['id']}"); await joe.reload()
        await joe.wait_for_selector(".jrk-recipe")
        check("staff start with no costing: no tab, no food cost on recipes",
              await joe.locator(".jrk-subnav a:has-text('Costing')").count() == 0 and "Food cost" not in await joe.inner_text(".jrk-recipe"))
        await joe.goto(K + "/costing")
        await joe.wait_for_selector("text=Costing is kept by your restaurant’s owner")
        check("and the costing pages say so", fake.costing_of(fake.users["joe@maple.test"], rid) == "none")
        await rae.goto(K + "/team")
        await rae.wait_for_selector(".jrk-teamlist")
        tl = await rae.inner_text(".jrk-teamlist")
        check("the owner's Team tab lists the team with emails", "joe@maple.test" in tl and "rae@maple.test" in tl and "owner" in tl.lower(), tl)
        await rae.select_option("select[aria-label='Costing for Joe Line']", "view")
        await rae.wait_for_timeout(600)
        check("the owner lets a staff member view the costing", fake.costing_of(fake.users["joe@maple.test"], rid) == "view")
        await joe.goto(K + f"/cost/{salsa['id']}"); await joe.reload()
        await joe.wait_for_selector(".jrk-summary")
        check("they then see the shared costing, read-only", "$0.50" in await joe.inner_text(".jrk-summary")
              and await joe.locator("input[aria-label='Price of tomatoes']").is_disabled())
        await rae.select_option("select[aria-label='Costing for Joe Line']", "edit")
        await rae.wait_for_timeout(600)
        await joe.reload()
        await joe.wait_for_selector(".jrk-summary")
        check("and with edit, can change prices", not await joe.locator("input[aria-label='Price of tomatoes']").is_disabled())
        await rae.goto(K + f"/{salsa['id']}")
        await rae.wait_for_selector(".jrk-facts")
        check("the recipe page shows its food cost", "$8.00 a batch, $0.50 a portion" in await rae.inner_text(".jrk-facts"))

        # help: sent through the website's contact form, or offered as an email where there is none
        sent_help = []
        async def inquiry(route):
            sent_help.append(json.loads(route.request.post_data))
            await route.fulfill(status=200, headers={"content-type": "application/json"}, body='{"ok": true}')
        await pctx.route("**/api/inquiry", inquiry)
        await rae.goto(K + "/help")
        await rae.wait_for_selector("textarea[aria-label='Your message']")
        check("Ask Joseph is a form with their name and email filled in",
              await rae.input_value("input[aria-label='Your email']") == "rae@maple.test" and await rae.input_value("input[aria-label='Your name']") == "Rae"
              and await rae.locator("select[aria-label='How soon you need an answer']").count() == 1)
        await rae.select_option("select[aria-label='Best way to reach you']", "phone")
        await rae.fill("textarea[aria-label='Your message']", "x")
        await rae.click("button:has-text('Send to Joseph')")
        check("asking for a call needs a phone number", "Add a phone number" in await rae.inner_text(".jrk-helpform .jrk-msg"))
        await rae.fill("input[aria-label='Phone (optional)']", "870-555-0100")
        await rae.select_option("select[aria-label='How soon you need an answer']", "week")
        await rae.select_option("select[aria-label='What it is about']", "Costing and prices")
        await rae.select_option("select[aria-label='Which recipe (optional)']", "House Salsa Roja")
        await rae.fill("textarea[aria-label='Your message']", "How do I price a case of tomatoes?")
        await rae.wait_for_timeout(3100)          # the contact form ignores anything sent within 3 seconds (a spam check)
        await rae.click("button:has-text('Send to Joseph')")
        await rae.wait_for_selector("text=Joseph has your message")
        check("help goes to Joseph through the website's contact form, from the signed-in email",
              sent_help and sent_help[0]["email"] == "rae@maple.test" and "Maple Street Grill" in sent_help[0]["message"]
              and "Costing and prices" in sent_help[0]["message"] and "case of tomatoes" in sent_help[0]["message"]
              and "Recipe: House Salsa Roja" in sent_help[0]["message"] and "Phone call" in sent_help[0]["message"]
              and "This week" in sent_help[0]["message"] and sent_help[0]["phone"] == "870-555-0100", sent_help)
        await joe.goto(K + "/help")
        await joe.wait_for_selector("textarea[aria-label='Your message']")
        await joe.fill("textarea[aria-label='Your message']", "Is the slaw gluten free?")
        await joe.click("button:has-text('Send to Joseph')")
        await joe.wait_for_selector("text=Joseph has your message")
        check("help is kept in Joseph's inbox even where the website's email form isn't there",
              any("Is the slaw gluten free?" in x["body"] and x["author_email"] == "joe@maple.test" and x["restaurant_id"] == rid for x in fake.messages.values()))
        await joe.wait_for_selector(".jrk-help li")
        check("and the sender sees it under Your messages", "with joseph" in (await joe.inner_text(".jrk-help")).lower())
        await jctx.route("**/rest/v1/restaurant_messages*", lambda route: route.abort())
        await joe.goto(K + "/help"); await joe.reload()
        await joe.wait_for_selector("textarea[aria-label='Your message']")
        await joe.fill("textarea[aria-label='Your message']", "Hello again")
        await joe.click("button:has-text('Send to Joseph')")
        await joe.wait_for_selector("a:has-text('Send it as an email instead')")
        check("when neither way works, help is offered as a ready email",
              (await joe.get_attribute("a:has-text('Send it as an email instead')", "href")).startswith("mailto:hello@jonesridgekitchen.com"))
        await jctx.unroute("**/rest/v1/restaurant_messages*")

        # ---- New recipes from the chef since the last visit
        from datetime import datetime, timezone
        fake.recipes["coll2"] = dict(id="coll2", owner_id=fake.users["chef@example.com"]["id"], scope="restaurant", restaurant_id=rid, status="approved",
                                     title="Smoked Brisket", categories=["Mains"], author_name=None, review_note=None, source_recipe_id=None,
                                     created_at=datetime.now(timezone.utc).isoformat(),
                                     body=dict(tags=[], yq="10", yu="servings", yr="", dir="Smoke low and slow.", ings=[["5", "", "lb", "brisket", ""]]))
        await rae.goto(K); await rae.reload()
        await rae.wait_for_selector(".jrk-newnote")
        check("recipes the chef added since the last visit are marked New",
              "1 new recipe" in await rae.inner_text(".jrk-newnote") and await rae.locator(".jrk-recipes li:has-text('Smoked Brisket') .jrk-tag.new").count() == 1
              and await rae.locator(".jrk-recipes li:has-text('Maple House Vinaigrette') .jrk-tag.new").count() == 0)
        await rae.reload()
        await rae.wait_for_selector(".jrk-recipes")
        check("and not once they have been seen", await rae.locator(".jrk-tag.new").count() == 0)

        # ---- prep list: recipes and batches, one list by aisle, with the cost for those who see costing
        await rae.goto(K + "/prep")
        await rae.wait_for_selector("select[aria-label='Add a recipe to the prep list']")
        await rae.select_option("select[aria-label='Add a recipe to the prep list']", label="House Salsa Roja")
        await rae.fill("input[aria-label='Batches of House Salsa Roja']", "2")
        await rae.press("input[aria-label='Batches of House Salsa Roja']", "Tab")
        await rae.select_option("select[aria-label='Add a recipe to the prep list']", label="Smoked Brisket")
        await rae.wait_for_selector(".jrk-preplines li:has-text('brisket')")
        prep = await rae.inner_text(".jrk-prepout")
        check("the prep list adds up the ingredients for every batch", "8 lb" in prep.lower() and "tomato" in prep.lower() and "5 lb" in prep, prep[:300])
        check("and shows its food cost to people who see costing", "Estimated food cost: $16.00" in prep, prep[-200:])
        await rae.screenshot(path="/tmp/portal_prep.png", full_page=True)

        # ---- plates: several recipes in one menu item
        await rae.goto(K + "/plate/new")
        await rae.wait_for_selector("input[aria-label='Plate name']")
        await rae.fill("input[aria-label='Plate name']", "Salsa Sampler")
        await rae.fill("input[aria-label='Plate menu price']", "4")
        await rae.select_option("select[aria-label='Add a recipe to the plate']", label="House Salsa Roja")
        await rae.fill("input[aria-label='Portions of House Salsa Roja']", "2")
        await rae.press("input[aria-label='Portions of House Salsa Roja']", "Tab")
        await rae.wait_for_selector(".jrk-summary:has-text('$1.00')")
        check("a plate costs its recipes' portions", "25%" in await rae.inner_text(".jrk-summary"))
        await rae.click("button:has-text('Save plate')")
        await rae.wait_for_selector("table.jrk-plates")
        check("plates are listed on Costing with their food cost", "Salsa Sampler" in await rae.inner_text("table.jrk-plates")
              and "25%" in await rae.inner_text("table.jrk-plates") and fake.kitchens[rid]["plates"][0]["parts"] == [{"id": salsa["id"], "n": 2}])
        # single ingredients on a plate: "1 oz tomato slices" uses the tomato price, a new one is priced right there
        await rae.click("table.jrk-plates a:has-text('Salsa Sampler')")
        add_ing = "input[aria-label='Add an ingredient to the plate']"
        await rae.wait_for_selector(add_ing)
        await rae.fill(add_ing, "1 oz tomato slices"); await rae.press(add_ing, "Enter")
        await rae.wait_for_selector(".jrk-plateing")
        check("a plate can hold a single ingredient, costed from the price book", "$0.13" in await rae.inner_text(".jrk-plateing >> nth=0"))
        await rae.fill(add_ing, "1 piece Monterey Jack cheese"); await rae.press(add_ing, "Enter")
        await rae.wait_for_selector(".jrk-plateing >> nth=1")
        check("one without a price says so", "needs a price" in await rae.inner_text(".jrk-plateing >> nth=1"))
        await rae.select_option("select[aria-label='Price unit for Monterey Jack cheese']", "each")
        await rae.fill("input[aria-label='Price of Monterey Jack cheese']", "0.30")
        await rae.press("input[aria-label='Price of Monterey Jack cheese']", "Tab")
        await rae.wait_for_selector(".jrk-plateing >> nth=1 >> text=$0.30")
        check("and can be priced on the plate, into the price book", fake.kitchens[rid]["items"].get("monterey jack cheese") == {"p": 0.3, "per": "each"},
              fake.kitchens[rid]["items"])
        await rae.screenshot(path="/tmp/portal_plate.png", full_page=True)
        check("the plate cost adds the ingredients to the recipes", "$1.4" in await rae.inner_text(".jrk-summary"), await rae.inner_text(".jrk-summary"))
        await rae.click("button:has-text('Save plate')")
        await rae.wait_for_selector("table.jrk-plates")
        check("and the plate keeps them", fake.kitchens[rid]["plates"][0]["parts"] == [{"id": salsa["id"], "n": 2}, {"t": "1 oz tomato slices"}, {"t": "1 piece Monterey Jack cheese"}]
              and "Monterey Jack" in await rae.inner_text("table.jrk-plates"), fake.kitchens[rid]["plates"][0]["parts"])
        await rae.goto(K + "/sheet")
        await rae.wait_for_selector("table.jrk-sheet tbody tr")
        check("plate ingredients appear on the price sheet too", "Salsa Sampler (plate)" in await rae.inner_text("table.jrk-sheet tr:has-text('Monterey')"))

        # ---- the costing sheet: every ingredient in the recipes, once, with its price
        await rae.goto(K + "/sheet")
        await rae.wait_for_selector("table.jrk-sheet tbody tr")
        sheet = await rae.inner_text("table.jrk-sheet")
        check("the price sheet lists every ingredient in the recipes once", all(x in sheet for x in ("Tomatoes", "Onion", "Cilantro", "Brisket"))
              and sheet.count("Tomatoes") == 1, sheet[:300])
        check("with the price already set, and what is still to do", await rae.input_value("input[aria-label='Price of Tomatoes']") == "2"
              and "priced" in await rae.inner_text(".jrk-sheet ~ p, p[role=status]"))
        await rae.select_option("select[aria-label='Show']", "missing")
        check("it can show only what still needs a price", await rae.locator("table.jrk-sheet tbody tr:has-text('Tomatoes')").count() == 0
              and await rae.locator("table.jrk-sheet tbody tr:has-text('Onion')").count() == 1)
        await rae.select_option("select[aria-label='Price unit for Onion']", "each")
        await rae.fill("input[aria-label='Price of Onion']", "0.75")
        await rae.press("input[aria-label='Price of Onion']", "Tab")
        await rae.wait_for_timeout(700)
        check("a price entered on the sheet is saved for every recipe", any(v == {"p": 0.75, "per": "each"} for v in fake.kitchens[rid]["items"].values()), fake.kitchens[rid]["items"])
        await rae.screenshot(path="/tmp/portal_sheet.png", full_page=True)

        # ---- a photo on one of the team's recipes
        import base64
        png = Path(tempfile.mkdtemp()) / "salsa.png"
        png.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC"))
        await rae.goto(K + f"/{salsa['id']}")
        await rae.wait_for_selector(".jrk-photobtns")
        async with rae.expect_file_chooser() as fc:
            await rae.click("button:has-text('Add a photo')")
        await (await fc.value).set_files(str(png))
        await rae.wait_for_selector(".jrk-photo img", timeout=15000)
        check("the team can add a photo to their recipe", (salsa.get("photo") or "").startswith(f"recipes/{fake.users['rae@maple.test']['id']}/"), salsa.get("photo"))
        await rae.goto(K + "/coll1")
        await rae.wait_for_selector(".jrk-recipe")
        check("but not to the chef's", await rae.locator(".jrk-photobtns").count() == 0)

        # ---- the admin: help inbox, and each restaurant's team with costing access
        await admin.goto(URL + "#/admin/restaurants")
        await admin.wait_for_selector(".inbox .msg")
        check("restaurant help messages wait in Admin tools, counted on the tab",
              "Is the slaw gluten free?" in await admin.inner_text(".inbox") and (await admin.inner_text(".admintab:has-text('Restaurants') .count")).strip() == "2")
        check("with a Reply by email link to the sender", (await admin.get_attribute(".inbox .msg a:has-text('Reply by email') >> nth=0", "href")).startswith("mailto:"))
        await admin.click(".inbox .msg:has-text('gluten free') button:has-text('Mark answered')")
        await admin.wait_for_timeout(700)
        check("and can be marked answered", any(x["status"] == "done" and "gluten" in x["body"] for x in fake.messages.values())
              and (await admin.inner_text(".admintab:has-text('Restaurants') .count")).strip() == "1")
        await open_card(admin, "Maple Street Grill")
        await admin.click(".restcard:has-text('Maple Street Grill') details.team summary")
        await admin.wait_for_selector(".restcard:has-text('Maple Street Grill') details.team select")
        check("the admin sees a restaurant's team and can set costing access",
              await admin.input_value(".restcard:has-text('Maple Street Grill') select[aria-label='Costing for Joe Line']") == "edit")
        await admin.select_option(".restcard:has-text('Maple Street Grill') select[aria-label='Costing for Joe Line']", "none")
        await admin.wait_for_timeout(600)
        check("and take it away", fake.costing_of(fake.users["joe@maple.test"], rid) == "none")

        # the admin's "View their portal": the restaurant's page as its team sees it, marked as a preview
        await admin.goto(PORTAL + f"?preview={rid}")
        await admin.wait_for_selector("#jrk-portal .jrk-recipes", timeout=15000)
        ptext = await admin.inner_text("#jrk-portal")
        check("the admin can preview a restaurant's portal without being on its team",
              "Preview." in ptext and "Maple Street Grill" in ptext and await admin.locator(".jrk-recipes a:has-text('Maple House Vinaigrette')").count() == 1
              and await admin.locator("button:has-text('Invite someone')").count() == 0)
        await admin.click(".jrk-recipes a:has-text('Maple House Vinaigrette')")
        await admin.wait_for_selector(".jrk-recipe")
        check("and open its recipes there", "olive oil" in await admin.inner_text(".jrk-recipe") and "Preview." in await admin.inner_text("#jrk-portal"))
        # the admin keeps the restaurant's prices: the card's Costing sheet link, editable in the preview
        await admin.goto(URL + "#/admin/restaurants")
        await open_card(admin, "Maple Street Grill")
        sheet_link = await admin.get_attribute(".restcard:has-text('Maple Street Grill') a.sheet", "href")
        check("each restaurant's card links to its costing sheet", sheet_link == f"https://jonesridgekitchen.com/my-meals/?preview={rid}#kitchen/{rid}/sheet", sheet_link)
        await admin.goto(PORTAL + f"?preview={rid}#kitchen/{rid}/sheet"); await admin.reload()
        await admin.wait_for_selector("table.jrk-sheet tbody tr")
        check("the admin sees the restaurant's price sheet in the preview, editable",
              await admin.input_value("input[aria-label='Price of Tomatoes']") == "2" and not await admin.locator("input[aria-label='Price of Cilantro']").is_disabled()
              and "as the admin you can change" in await admin.inner_text("#jrk-portal"))
        await admin.fill("input[aria-label='Price of Cilantro']", "1.25")
        await admin.press("input[aria-label='Price of Cilantro']", "Tab")
        await admin.wait_for_timeout(700)
        check("and the admin's price is saved for the restaurant", any(v.get("p") == 1.25 for v in fake.kitchens[rid]["items"].values()), fake.kitchens[rid]["items"])
        check("but nothing else can be changed in the preview", await admin.locator("a:has-text('+ Add a recipe')").count() == 0)
        await admin.goto(PORTAL + f"?preview={rid}#kitchen/{rid}/help")
        await admin.wait_for_selector("form.jrk-helpform")
        check("the preview shows the help form, with sending switched off", await admin.locator("form.jrk-helpform button[type=submit]").is_disabled())
        await rae.goto(PORTAL + f"?preview={rid}")
        await rae.reload()
        await rae.wait_for_selector("#jrk-portal .jrk-recipes", timeout=15000)
        check("a preview link does nothing special for anyone but the admin", "Preview." not in await rae.inner_text("#jrk-portal"))

        # a login that is both a meal prep client and on a restaurant team gets a switcher
        fake.members.append(dict(user_id=fake.users["anna@example.com"]["id"], restaurant_id=rid, member_role="staff"))
        await anna.fill("#jrk-portal input[aria-label=Email]", "anna@example.com")
        await anna.fill("#jrk-portal input[aria-label=Password]", "annapass99")
        await anna.click("#jrk-portal button[type=submit]")
        await anna.wait_for_selector(".jrk-switch")
        check("meal prep comes first for a client on both", "Hello, Anna" in await anna.inner_text("#jrk-portal"))
        await anna.click(".jrk-switch a:has-text('Maple Street Grill')")
        await anna.wait_for_selector(".jrk-recipes")
        check("the switcher opens the restaurant's recipes", await anna.locator(".jrk-switch a[aria-current=page]:has-text('Maple Street Grill')").count() == 1)
        await anna.click(".jrk-switch a:has-text('My meals')")
        await anna.wait_for_selector("text=Hello, Anna")
        check("and back to their meals", True)
        fake.members.pop()

        fake.no_clients = True
        await admin.goto(URL + "#/clients")
        await admin.wait_for_selector("text=add_clients.sql")
        check("a database without the client section is explained", True)
        fake.no_clients = False
        # ---- a shopping list shared with the household
        await admin.goto(URL + "#/shop")
        await admin.click(".household summary")
        await admin.click("button:has-text('Start a household')")
        await admin.wait_for_selector(".household .code")
        code = (await admin.inner_text(".household .code")).strip()
        check("starting a household shows its join code", len(code) == 6)
        await admin.fill(".addextra input", "Oat milk"); await admin.click(".addextra button")
        await admin.wait_for_timeout(1200)
        await o.goto(URL + "#/shop")
        await o.click(".household summary")
        await o.fill("input[aria-label='Household code']", code.lower())
        await o.click("button:has-text('Join a household')")
        await o.wait_for_selector(".household .code")
        check("joining shows the shared list", "Oat milk" in await o.inner_text("ul.shoplist"))
        check("joining shows who's in it", "Shared with" in await o.inner_text(".sharednote"))
        await o.click("ul.shoplist li:has-text('Oat milk') .tick")
        await o.wait_for_timeout(1200)
        await admin.goto(URL + "#/plan"); await admin.goto(URL + "#/shop")
        await admin.wait_for_timeout(1500)
        check("a tick on one phone shows on the other", await admin.get_attribute("ul.shoplist li:has-text('Oat milk') .tick", "aria-pressed") == "true")
        await admin.click("button:has-text('Leave')")
        await admin.click("dialog[open] button:has-text('Leave')")
        await admin.wait_for_timeout(500)
        check("leaving stops the sharing", await admin.locator(".household summary").count() == 1)

        # ---- deleting your own account
        await o.goto(URL + "#/settings")
        await o.click("details.dangerzone summary")
        await o.click("details.dangerzone button:has-text('Delete my account')")
        await o.wait_for_selector("dialog[open]")
        check("deleting an account asks first", "can’t be undone" in await o.inner_text("dialog[open]"))
        await o.click("dialog[open] button:has-text('Delete account')")
        check("deleting an account says it is done", "Account deleted" in await close_dialog(o))
        check("the account is gone from the server", "val@example.com" not in fake.users)
        await o.wait_for_selector("button[role=tab]:has-text('Sign in')")
        check("after deleting, the app is signed out", True)
        await admin.goto(URL + "#/settings")
        await admin.wait_for_selector("text=Sign out")
        check("the admin has no delete-account button", await admin.locator("details.dangerzone").count() == 0)
        await octx.close()

        # desktop screenshot of admin
        await admin.set_viewport_size({"width": 1280, "height": 900})
        await admin.goto(URL + "#/settings")
        await admin.wait_for_selector("text=Sign out")
        await admin.screenshot(path="/tmp/cloud_settings_desktop.png")
        await b.close()
    real = [e for e in errors if "Failed to load resource" not in e and "net::ERR" not in e]
    check("no JavaScript errors", not real, real[:3])
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


sys.exit(asyncio.run(main()))
