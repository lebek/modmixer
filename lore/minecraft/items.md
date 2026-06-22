## Custom sword/tool: SwordItem + a Tier, attributes via SwordItem.createAttributes (1.21)

A weapon is `new SwordItem(tier, new Item.Properties().attributes(SwordItem.createAttributes(tier, baseDamage, attackSpeed)))`. For a custom tier use NeoForge's `net.neoforged.neoforge.common.SimpleTier(incorrectBlocksForDropsTag, uses, speed, attackDamageBonus, enchantmentValue, () -> repairIngredient)`, or implement `net.minecraft.world.item.Tier`. The vanilla registrations live in `net.minecraft.world.item.Items` (e.g. `DIAMOND_SWORD`).

*Why it's tricky:* in 1.21 attack damage/speed come from the attributes component (`SwordItem.createAttributes(tier, dmg, speed)`), NOT constructor ints like older guides show. Pull the exact current shape with `search_source "DIAMOND_SWORD = register"` and `read_csharp_symbol SwordItem` rather than reconstructing from memory.
