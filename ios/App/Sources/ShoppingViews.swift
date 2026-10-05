import SwiftUI
import InstantClient

struct ProductResultsView: View {
    let messageID: String
    let selections: [ProductSelection]

    var body: some View {
        ForEach(selections) { selection in
            ProductSelectionView(messageID: messageID, selection: selection)
        }
    }
}

private struct ProductSelectionView: View {
    let messageID: String
    let selection: ProductSelection
    @Environment(AppModel.self) private var model
    @State private var products: [ShoppingProduct] = []
    @State private var loading = true
    @State private var failed = false
    @State private var retry = 0
    @State private var detail: ShoppingProduct?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Products", systemImage: "bag").font(.system(size: 14, weight: .semibold))
                Spacer()
                Text("Shopify Catalog").font(.system(size: 12)).foregroundStyle(InstantStyle.muted)
            }.foregroundStyle(InstantStyle.forest)
            if loading {
                HStack(spacing: 10) { ProgressView(); Text("Getting current products…") }
                    .font(.system(size: 14)).foregroundStyle(InstantStyle.muted).padding(.vertical, 22)
            } else if failed {
                Text("Product information is temporarily unavailable.").font(.system(size: 14)).foregroundStyle(InstantStyle.muted)
                Button("Try again") { retry += 1 }.frame(minHeight: 44).tint(InstantStyle.forest)
            } else if products.isEmpty {
                Text("No current products match this selection and budget. Ask Impo to search again.")
                    .font(.system(size: 14)).foregroundStyle(InstantStyle.muted)
            } else {
                ShoppingCards(products: products) { detail = $0 }
                Text("Current catalog prices. Shipping and taxes may vary.")
                    .font(.system(size: 12)).foregroundStyle(InstantStyle.muted)
            }
        }.frame(minHeight: loading || !products.isEmpty ? 440 : nil, alignment: .top)
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain).accessibilityIdentifier("shopping.results")
        .preference(key: ConversationLayoutRevisionKey.self, value: loading ? [:] : [selection.id: products.count])
        .task(id: "\(model.listeningScope ?? "")|\(selection.id)|\(retry)") {
            detail = nil; products = []; loading = true; failed = false
            do { products = try await model.shoppingProducts(messageID: messageID, selectionID: selection.id).products; loading = false }
            catch is CancellationError { }
            catch { if !Task.isCancelled { loading = false; failed = true } }
        }
        .sheet(item: $detail) { product in
            ProductDetailView(messageID: messageID, selectionID: selection.id, initial: product)
        }
    }
}

struct ShoppingCards: View {
    let products: [ShoppingProduct]
    let select: (ShoppingProduct) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 14) {
                ForEach(products) { product in
                    Button { select(product) } label: {
                        VStack(alignment: .leading, spacing: 9) {
                            ProductImage(url: product.image).frame(height: 180)
                                .frame(maxWidth: .infinity).background(.white.opacity(0.55)).clipShape(RoundedRectangle(cornerRadius: 12))
                            Text(product.merchant).font(.system(size: 12, weight: .medium)).foregroundStyle(InstantStyle.muted).lineLimit(2)
                            Text(product.title).font(.system(size: 17, weight: .medium)).foregroundStyle(InstantStyle.ink)
                                .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                            Text(product.price?.formatted ?? "See current price").font(.system(size: 16, weight: .semibold)).foregroundStyle(InstantStyle.forest)
                            HStack(spacing: 5) {
                                Text(product.available == false ? "Currently unavailable" : "View details")
                                Image(systemName: "arrow.right").font(.system(size: 11))
                            }.font(.system(size: 13)).foregroundStyle(InstantStyle.muted).frame(minHeight: 30)
                        }.frame(width: typeSize.isAccessibilitySize ? 280 : 224, alignment: .leading)
                            .multilineTextAlignment(.leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("shopping.product")
                        .accessibilityLabel("\(product.title), \(product.merchant), \(product.price?.formatted ?? "Price unavailable")")
                        .accessibilityHint("Shows product details")
                }
            }.padding(.bottom, 4)
        }.scrollIndicators(.hidden)
    }
}

private struct ProductImage: View {
    let url: URL?
    @State private var image: UIImage?
    // Merchant images are displayed from the source without a disk or shared HTTP cache.
    private static let session = URLSession(configuration: .ephemeral)
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else { Image(systemName: "bag").font(.system(size: 32, weight: .light)).foregroundStyle(InstantStyle.muted.opacity(0.6)).frame(maxWidth: .infinity, maxHeight: .infinity) }
        }.accessibilityHidden(true).task(id: url) {
            image = nil
            guard let url else { return }
            var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            guard let (data, response) = try? await Self.session.data(for: request), !Task.isCancelled,
                  (response as? HTTPURLResponse)?.statusCode == 200, data.count < 8_000_000 else { return }
            image = UIImage(data: data)
        }
    }
}

private struct ProductDetailView: View {
    let messageID: String
    let selectionID: String
    let initial: ShoppingProduct
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var current: ShoppingProduct?
    @State private var notice: String?
    @State private var expandedDescription = false
    private var product: ShoppingProduct { current ?? initial }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ProductImage(url: product.image).frame(height: 285).frame(maxWidth: .infinity)
                    Text(product.merchant).font(.system(size: 14)).foregroundStyle(InstantStyle.muted)
                    Text(product.title).font(InstantStyle.serif(28)).foregroundStyle(InstantStyle.ink)
                    Text(product.price?.formatted ?? "Price unavailable").font(.system(size: 22, weight: .semibold)).foregroundStyle(InstantStyle.forest)
                    if product.available == false { Text("Currently unavailable").foregroundStyle(InstantStyle.muted) }
                    ForEach(product.options, id: \.name) { option in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(option.name).font(.system(size: 14, weight: .semibold))
                            Text(option.values.joined(separator: " · ")).font(.system(size: 14)).foregroundStyle(InstantStyle.muted)
                        }
                    }
                    if let description = product.description, !description.isEmpty {
                        let collapsible = description.count > 320
                        VStack(alignment: .leading, spacing: 10) {
                            Text("About this product").font(.headline).foregroundStyle(InstantStyle.ink)
                            Text(description).font(.body).foregroundStyle(InstantStyle.ink).lineSpacing(5)
                                .lineLimit(expandedDescription || !collapsible ? nil : 6)
                                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                            if collapsible {
                                Button(expandedDescription ? "Show less" : "Read full description") {
                                    expandedDescription.toggle()
                                }.font(.subheadline.weight(.semibold)).foregroundStyle(InstantStyle.forest)
                                    .frame(minHeight: 44).buttonStyle(.plain).accessibilityIdentifier("shopping.description.toggle")
                            }
                        }
                    }
                    if let notice { Text(notice).font(.footnote).foregroundStyle(InstantStyle.muted) }
                }.padding(22)
            }.background(InstantStyle.paper).navigationTitle("Product details").navigationBarTitleDisplayMode(.inline)
                .safeAreaInset(edge: .bottom, spacing: 0) { storeAction }
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.task(id: model.listeningScope) {
            do {
                let result = try await model.shoppingProducts(messageID: messageID, selectionID: selectionID, productID: initial.id)
                current = result.products.first
                if current == nil { notice = "This product is no longer available within this selection and budget." }
            } catch is CancellationError { }
            catch { if !Task.isCancelled { notice = "Couldn't refresh details. Open the store to check availability." } }
        }
    }

    private var storeAction: some View {
        VStack(spacing: 10) {
            if let url = product.merchantURL {
                Button { openURL(url) { if !$0 { notice = "Couldn't open the store. Try again." } } } label: {
                    Label("View at \(product.merchant)", systemImage: "arrow.up.right")
                        .font(.headline).multilineTextAlignment(.center)
                        .foregroundStyle(InstantStyle.paperElevated)
                        .padding(.horizontal, 18).padding(.vertical, 14)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background(InstantStyle.forest, in: RoundedRectangle(cornerRadius: 18))
                }.buttonStyle(PressStyle()).accessibilityIdentifier("shopping.openStore")
            }
            Text("From Shopify Catalog. Confirm options, shipping and the final price with the store.")
                .font(.caption).foregroundStyle(InstantStyle.muted).multilineTextAlignment(.center)
        }.padding(.horizontal, 22).padding(.top, 14).padding(.bottom, 12)
            .background(InstantStyle.paper)
            .overlay(alignment: .top) { Rectangle().fill(InstantStyle.border.opacity(0.5)).frame(height: 0.5) }
    }
}

#if DEBUG
struct ShoppingFixture: View {
    @State private var selected: ShoppingProduct?
    private var products: [ShoppingProduct] {
        let json = """
        [{"id":"gid://shopify/p/test","title":"Everyday Commuter Backpack","merchant":"Example Outdoor","url":"https://example.com/backpack","price":{"amount":8900,"currency":"USD","formatted":"USD 89.00"},"available":true,"description":"Made for the daily commute, this backpack keeps everyday essentials organized in a compact shape. The padded shoulder straps and lightweight body are designed for comfortable travel on foot or by train.\\n\\nA padded compartment holds your laptop, while smaller pockets keep keys, cables and travel documents easy to find. Side pockets provide room for a water bottle or a compact umbrella.\\n\\nThe main compartment opens wide for packing. Check the merchant page for exact dimensions, material care and device compatibility before choosing your size. Product photographs may show accessories that are sold separately.\\n\\nAvailable colors and stock can change. The store provides current shipping destinations, delivery estimates and its return policy at the time of purchase.","options":[{"name":"Capacity","values":["20 L","25 L"]}]},
        {"id":"gid://shopify/p/test2","title":"Compact Travel Pack","merchant":"Example Supply","url":"https://example.com/pack","price":{"amount":12500,"currency":"JPY","formatted":"JPY 12,500"},"available":true,"options":[]}]
        """
        return (try? JSONDecoder().decode([ShoppingProduct].self, from: Data(json.utf8))) ?? []
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("A little lighter, every day.").font(InstantStyle.serif(27))
            Text("Two options for your daily commute.").foregroundStyle(InstantStyle.muted)
            ShoppingCards(products: products) { selected = $0 }
            Spacer()
        }.padding(22).background(InstantStyle.paper)
            .sheet(item: $selected) { product in
                ProductDetailView(messageID: "fixture", selectionID: "fixture", initial: product)
            }
    }
}
#endif
